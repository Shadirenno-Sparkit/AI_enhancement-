import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Connector } from '@aiapp/shared';
import { config } from '../config.js';
import { db, now, parseJson } from '../db/index.js';
import { id } from '../util/ids.js';

/**
 * Connector secrets are encrypted at rest with AES-256-GCM under a key derived
 * from JWT_SECRET (spec §12 "Credential handling"). They are never returned by
 * the API — the client only ever learns whether a connector is configured.
 *
 * For a multi-tenant production deployment, swap this module's key source for a
 * managed KMS/secrets manager; the interface is what the rest of the app uses.
 */
function key(): Buffer {
  return scryptSync(config().jwtSecret, 'aiapp-connector-v1', 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string | null {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

interface ConnectorRow {
  connector_id: string;
  user_id: string;
  kind: string;
  label: string;
  secret_enc: string | null;
  scopes: string;
  created_at: string;
}

function toConnector(row: ConnectorRow): Connector {
  return {
    connectorId: row.connector_id,
    userId: row.user_id,
    kind: row.kind,
    label: row.label,
    configured: Boolean(row.secret_enc),
    scopes: parseJson<string[]>(row.scopes, []),
    createdAt: row.created_at,
  };
}

export function upsertConnector(input: {
  userId: string;
  kind: string;
  label?: string;
  secret?: string | null;
  scopes?: string[];
}): Connector {
  const existing = getConnector(input.userId, input.kind);
  const connectorId = existing?.connectorId ?? id('con');
  const secretEnc =
    input.secret === undefined
      ? existing
        ? rawSecret(input.userId, input.kind)
        : null
      : input.secret
        ? encryptSecret(input.secret)
        : null;

  db()
    .prepare(
      `INSERT INTO connectors (connector_id, user_id, kind, label, secret_enc, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET
         label = excluded.label, secret_enc = excluded.secret_enc, scopes = excluded.scopes`,
    )
    .run(
      connectorId,
      input.userId,
      input.kind,
      input.label ?? existing?.label ?? input.kind,
      secretEnc,
      JSON.stringify(input.scopes ?? existing?.scopes ?? []),
      existing?.createdAt ?? now(),
    );
  return getConnector(input.userId, input.kind)!;
}

function rawSecret(userId: string, kind: string): string | null {
  const row = db()
    .prepare('SELECT secret_enc FROM connectors WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as { secret_enc: string | null } | undefined;
  return row?.secret_enc ?? null;
}

export function getConnector(userId: string, kind: string): Connector | null {
  const row = db()
    .prepare('SELECT * FROM connectors WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as ConnectorRow | undefined;
  return row ? toConnector(row) : null;
}

export function listConnectors(userId: string): Connector[] {
  const rows = db()
    .prepare('SELECT * FROM connectors WHERE user_id = ? ORDER BY kind ASC')
    .all(userId) as ConnectorRow[];
  return rows.map(toConnector);
}

/** Only the implementation engine calls this, and only for an approved item's scopes. */
export function revealConnectorSecret(userId: string, kind: string): string | null {
  const enc = rawSecret(userId, kind);
  return enc ? decryptSecret(enc) : null;
}

export function deleteConnector(userId: string, kind: string): boolean {
  return db().prepare('DELETE FROM connectors WHERE user_id = ? AND kind = ?').run(userId, kind).changes > 0;
}

/**
 * Prerequisite names the analyzer emits (e.g. "email connector", "GitHub") are
 * matched loosely against the user's configured connectors so BR-A6 can flag
 * what is genuinely missing without demanding an exact string.
 */
export function findMissingPrerequisites(userId: string, prerequisites: string[]): string[] {
  if (prerequisites.length === 0) return [];
  const configured = listConnectors(userId)
    .filter((c) => c.configured)
    .flatMap((c) => [c.kind.toLowerCase(), c.label.toLowerCase()]);

  const ALIASES: Record<string, string[]> = {
    email: ['gmail', 'outlook', 'smtp', 'mail'],
    calendar: ['google calendar', 'gcal', 'outlook'],
    files: ['filesystem', 'drive', 'google drive', 'dropbox'],
    chat: ['slack', 'teams', 'discord'],
    code: ['github', 'gitlab', 'bitbucket'],
  };

  return prerequisites.filter((prereq) => {
    const needle = prereq.toLowerCase().replace(/\b(connector|integration|access|account)\b/g, '').trim();
    if (!needle) return false;
    if (configured.some((c) => c.includes(needle) || needle.includes(c))) return false;
    for (const [family, members] of Object.entries(ALIASES)) {
      if (!needle.includes(family)) continue;
      if (configured.some((c) => members.some((m) => c.includes(m)))) return false;
    }
    return true;
  });
}
