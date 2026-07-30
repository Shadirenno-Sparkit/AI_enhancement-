/* eslint-env serviceworker */
/**
 * AI Enhancement App — service worker.
 *
 * Three jobs, in order of importance to the product:
 *
 *  1. Be the Web Share Target. The OS POSTs the shared post here; we take the
 *     URL, queue it, and get the user back to their feed immediately. This is
 *     the "one tap, zero fields" promise (BR-C1, BR-C5), and it must work even
 *     with no network — hence the queue rather than a direct API call.
 *  2. Hold an offline capture queue and flush it when connectivity returns
 *     (BR-C7). A capture must never be lost.
 *  3. Cache the app shell so the UI opens instantly and works offline.
 */

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const QUEUE_DB = 'aiapp-capture-queue';
const QUEUE_STORE = 'pending';

const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // A missing optional asset must not block activation.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// ─── Capture queue (IndexedDB) ───────────────────────────────────────────────

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(QUEUE_STORE)) {
        request.result.createObjectStore(QUEUE_STORE, { keyPath: 'clientRef' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queuePut(entry) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const request = tx.objectStore(QUEUE_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function queueDelete(clientRef) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).delete(clientRef);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Attempts to submit everything queued.
 *
 * The access token is passed in by the page (the SW has no access to
 * localStorage). Without one we leave the queue intact — the app flushes it on
 * next launch once the user is signed in.
 */
async function flushQueue(token) {
  if (!token) return { sent: 0, remaining: (await queueAll()).length };

  let sent = 0;
  for (const entry of await queueAll()) {
    try {
      const response = await fetch('/v1/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          url: entry.url,
          sharedText: entry.sharedText,
          note: entry.note,
          captureSource: entry.captureSource || 'share_target',
          clientRef: entry.clientRef,
        }),
      });
      // 4xx other than auth means this entry will never succeed — drop it
      // rather than retrying a bad link forever.
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 401)) {
        await queueDelete(entry.clientRef);
        if (response.ok) sent++;
      }
    } catch {
      // Still offline; keep it queued.
      break;
    }
  }
  return { sent, remaining: (await queueAll()).length };
}

// ─── Share target ────────────────────────────────────────────────────────────

/** Pulls the first http(s) URL out of arbitrary shared text. */
function extractUrl(input) {
  if (!input) return null;
  const match = String(input).match(/https?:\/\/[^\s<>"')\]]+/i);
  return match ? match[0].replace(/[.,;:!?)\]}'"]+$/, '') : null;
}

async function handleShare(request) {
  let url = null;
  let sharedText = '';

  try {
    const form = await request.formData();
    const rawUrl = form.get('url');
    const text = form.get('text');
    const title = form.get('title');

    // Android routinely delivers the link in `text` rather than `url`, and iOS
    // often sends "caption… https://link" — check every field.
    url = extractUrl(rawUrl) || extractUrl(text) || extractUrl(title);
    sharedText = [title, text]
      .filter(Boolean)
      .map(String)
      .join('\n')
      .replace(url || '', '')
      .trim();
  } catch {
    // fall through to the error redirect below
  }

  if (!url) {
    return Response.redirect('/#/capture?error=no-link', 303);
  }

  const clientRef = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await queuePut({
    clientRef,
    url,
    sharedText,
    note: null,
    captureSource: 'share_target',
    queuedAt: new Date().toISOString(),
  });

  // Straight back to a confirmation screen — the page flushes the queue on load.
  return Response.redirect(`/#/captured?ref=${encodeURIComponent(clientRef)}`, 303);
}

// ─── Fetch routing ───────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(request));
    return;
  }

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API responses are never cached — status must always be live.
  if (url.pathname.startsWith('/v1/') || url.pathname === '/health') return;

  // Navigations: network first, shell fallback so the app opens offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((cached) => cached || fetch(request))),
    );
    return;
  }

  // Static assets: cache first, refreshing in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// ─── Messages from the page ──────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'FLUSH_QUEUE') {
    event.waitUntil(
      flushQueue(data.token).then((result) => {
        event.source?.postMessage({ type: 'QUEUE_FLUSHED', ...result });
      }),
    );
  }

  if (data.type === 'ENQUEUE') {
    event.waitUntil(queuePut(data.entry));
  }

  if (data.type === 'QUEUE_STATUS') {
    event.waitUntil(
      queueAll().then((entries) => {
        event.source?.postMessage({ type: 'QUEUE_STATUS', count: entries.length, entries });
      }),
    );
  }
});

// Background Sync, where the browser supports it: the queue flushes without the
// app being open.
self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-captures') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        for (const client of clients) client.postMessage({ type: 'REQUEST_FLUSH' });
      }),
    );
  }
});

// ─── Push ────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = { title: 'AI Enhancement App', body: 'Something is ready for you.', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: payload.url },
      tag: 'aiapp-notification',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
