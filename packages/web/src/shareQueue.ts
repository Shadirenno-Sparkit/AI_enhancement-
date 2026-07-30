import { loadTokens } from './api';

/**
 * Bridge between the page and the service worker's offline capture queue.
 *
 * The service worker owns the queue (it is the only context alive when the OS
 * hands over a share), but it cannot read localStorage — so the page supplies
 * the access token whenever a flush is needed. That split is the whole reason
 * this module exists.
 */

export interface QueuedCapture {
  clientRef: string;
  url: string;
  sharedText?: string;
  note?: string | null;
  captureSource?: string;
  queuedAt: string;
}

function controller(): ServiceWorker | null {
  return navigator.serviceWorker?.controller ?? null;
}

/** Sends a message and resolves with the first matching reply, or null on timeout. */
function ask<T>(message: unknown, expect: string, timeoutMs = 4000): Promise<T | null> {
  const sw = controller();
  if (!sw) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent): void => {
      if ((event.data as { type?: string })?.type !== expect) return;
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(event.data as T);
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    sw.postMessage(message);
  });
}

/** Submits everything the service worker has queued. Safe to call often. */
export async function flushQueue(): Promise<{ sent: number; remaining: number } | null> {
  const tokens = loadTokens();
  if (!tokens) return null;
  return ask<{ sent: number; remaining: number }>({ type: 'FLUSH_QUEUE', token: tokens.accessToken }, 'QUEUE_FLUSHED', 20_000);
}

export async function queueStatus(): Promise<{ count: number; entries: QueuedCapture[] } | null> {
  return ask<{ count: number; entries: QueuedCapture[] }>({ type: 'QUEUE_STATUS' }, 'QUEUE_STATUS');
}

/** Queues a capture locally — used when a direct submit fails while offline. */
export function enqueueCapture(entry: QueuedCapture): void {
  controller()?.postMessage({ type: 'ENQUEUE', entry });
}

/**
 * Registers the service worker and wires up automatic flushing: on load, when
 * connectivity returns, and when the worker itself asks (Background Sync).
 */
export async function registerServiceWorker(onFlushed?: (result: { sent: number; remaining: number }) => void): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data as { type?: string; sent?: number; remaining?: number };
      if (data?.type === 'REQUEST_FLUSH') void flushQueue();
      if (data?.type === 'QUEUE_FLUSHED' && onFlushed) {
        onFlushed({ sent: data.sent ?? 0, remaining: data.remaining ?? 0 });
      }
    });

    window.addEventListener('online', () => void flushQueue());

    const result = await flushQueue();
    if (result && onFlushed) onFlushed(result);
  } catch {
    // No service worker means no share target and no offline queue, but the
    // app itself still works — capture falls back to a direct API call.
  }
}

/** Asks for notification permission and registers a push subscription. */
export async function subscribeToPush(publicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing.toJSON();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  return subscription.toJSON();
}

/** VAPID keys are base64url; the Push API wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
