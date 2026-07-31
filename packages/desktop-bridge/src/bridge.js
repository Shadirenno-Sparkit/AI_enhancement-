#!/usr/bin/env node
/**
 * AI Enhancement App — desktop bridge.
 *
 * This is the answer to open question Q1 in both documents: how the hosted
 * backend gets per-link folders onto the user's actual desktop. It is a small
 * polling client rather than a sync daemon, chosen deliberately —
 *
 *   - it needs no inbound connection, so it works behind any home network;
 *   - it only ever writes inside the folder you point it at;
 *   - it is dependency-free Node, so `node src/bridge.js` is the whole install.
 *
 * Run it on the machine where you want the files:
 *
 *   BRIDGE_TOKEN=... BRIDGE_API_URL=https://your-host npm run bridge
 *
 * Files are written to "~/Desktop/AI Enhancement App" by default, one subfolder
 * per processed link, matching Technical Specification §11.1 exactly.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT_FOLDER_NAME = 'AI Enhancement App';
const STATE_FILE = '.aiapp-bridge-state.json';

function expandHome(target) {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

/** Loads config from env, falling back to a .env file beside the repo root. */
async function loadConfig() {
  const envFile = path.resolve(process.cwd(), '.env');
  if (existsSync(envFile)) {
    const contents = await fs.readFile(envFile, 'utf8');
    for (const line of contents.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }

  const apiUrl = (process.env.BRIDGE_API_URL || 'http://localhost:4000').replace(/\/$/, '');
  const token = process.env.BRIDGE_TOKEN || '';
  const dest = path.resolve(expandHome(process.env.BRIDGE_DEST || path.join('~', 'Desktop', ROOT_FOLDER_NAME)));
  const pollSeconds = Number(process.env.BRIDGE_POLL_SECONDS || 60);

  return { apiUrl, token, dest, pollSeconds };
}

let accessToken = '';
let refreshToken = '';

async function apiFetch(config, apiPath, options = {}) {
  const response = await fetch(`${config.apiUrl}${apiPath}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });

  // The bridge runs unattended for days, so it must survive token expiry.
  if (response.status === 401 && refreshToken) {
    const refreshed = await fetch(`${config.apiUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (refreshed.ok) {
      const body = await refreshed.json();
      accessToken = body.accessToken;
      refreshToken = body.refreshToken;
      await saveTokens(config);
      return apiFetch(config, apiPath, options);
    }
  }

  return response;
}

async function saveTokens(config) {
  const statePath = path.join(config.dest, STATE_FILE);
  const state = await readState(config);
  state.refreshToken = refreshToken;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function readState(config) {
  try {
    return JSON.parse(await fs.readFile(path.join(config.dest, STATE_FILE), 'utf8'));
  } catch {
    return { synced: {}, refreshToken: '' };
  }
}

async function writeState(config, state) {
  await fs.mkdir(config.dest, { recursive: true });
  await fs.writeFile(path.join(config.dest, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

/** Rejects any archive path that would escape the destination folder. */
function safeJoin(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside the destination: ${relative}`);
  }
  return resolved;
}

async function syncOnce(config) {
  const state = await readState(config);
  state.synced = state.synced || {};

  const libraryResponse = await apiFetch(config, '/v1/library?limit=500');
  if (!libraryResponse.ok) {
    if (libraryResponse.status === 401) {
      console.error('✗ Not authorised. Set BRIDGE_TOKEN to a valid access token (Settings → export, or sign in).');
      return { written: 0, fatal: true };
    }
    console.error(`✗ Could not list links (HTTP ${libraryResponse.status})`);
    return { written: 0 };
  }

  const { entries } = await libraryResponse.json();
  await fs.mkdir(config.dest, { recursive: true });

  let written = 0;

  for (const entry of entries) {
    if (!entry.folderPath) continue;

    // Skip folders whose contents have not changed since the last pass.
    if (state.synced[entry.jobId] === entry.updatedAt) continue;

    const filesResponse = await apiFetch(config, `/v1/artifacts/${entry.jobId}/files`);
    if (!filesResponse.ok) continue;
    const { files } = await filesResponse.json();

    for (const file of files) {
      // Raw media is retention-limited server-side and large; the derived text
      // is what belongs on the desktop.
      if (file.startsWith('media/')) continue;

      const fileResponse = await apiFetch(
        config,
        `/v1/artifacts/${entry.jobId}/file?path=${encodeURIComponent(file)}`,
      );
      if (!fileResponse.ok) continue;

      const target = safeJoin(config.dest, path.join(entry.folderPath, file));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(await fileResponse.arrayBuffer()));
      written++;
    }

    state.synced[entry.jobId] = entry.updatedAt;
    console.log(`  ↓ ${entry.folderPath}`);
  }

  // The index is rewritten every pass so it always reflects current status.
  const indexLines = [
    '# AI Enhancement App',
    '',
    'Synced by the desktop bridge. One folder per captured link.',
    '',
    `*Last synced: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC*`,
    '',
    '| Date | Platform | Title | Status | Items | Folder |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    if (!entry.folderPath) continue;
    indexLines.push(
      `| ${entry.createdAt.slice(0, 10)} | ${entry.platform} | [${entry.title.replace(/\|/g, '\\|')}](${entry.url}) | ${
        entry.state
      } | ${entry.itemCounts.approved}/${entry.itemCounts.total} | [\`${entry.folderPath}\`](./${encodeURI(
        entry.folderPath,
      )}/) |`,
    );
  }
  await fs.writeFile(path.join(config.dest, '_index.md'), `${indexLines.join('\n')}\n`, 'utf8');

  await writeState(config, state);
  return { written };
}

async function main() {
  const config = await loadConfig();
  const once = process.argv.includes('--once');

  if (!config.token) {
    console.error('BRIDGE_TOKEN is not set.');
    console.error('');
    console.error('Get one by signing in to the app and copying the access token from');
    console.error('localStorage under the key "aiapp.tokens", or run:');
    console.error('');
    console.error(`  curl -s -X POST ${config.apiUrl}/v1/auth/login \\`);
    console.error(`    -H 'Content-Type: application/json' \\`);
    console.error(`    -d '{"email":"you@example.com","password":"..."}'`);
    process.exit(1);
  }

  accessToken = config.token;
  const state = await readState(config);
  refreshToken = state.refreshToken || process.env.BRIDGE_REFRESH_TOKEN || '';

  console.log('AI Enhancement App — desktop bridge');
  console.log(`  server: ${config.apiUrl}`);
  console.log(`  folder: ${config.dest}`);
  console.log(once ? '  mode:   one-shot' : `  mode:   polling every ${config.pollSeconds}s`);
  console.log('');

  const run = async () => {
    try {
      const result = await syncOnce(config);
      if (result.fatal) process.exit(1);
      if (result.written > 0) console.log(`✓ Wrote ${result.written} file${result.written === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(`✗ Sync failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  await run();
  if (once) return;

  setInterval(() => void run(), Math.max(10, config.pollSeconds) * 1000);
  process.on('SIGINT', () => {
    console.log('\nStopped.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
