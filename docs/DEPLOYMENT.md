# Deployment

The whole product is one Node process serving the API and the PWA, plus a SQLite
file. That is deliberate — see the deviations section of
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Local

```bash
npm install
cp .env.example .env
npm run build
npm start                # http://localhost:4000
```

Development with hot reload:

```bash
npm run dev              # API :4000, PWA :5173 (proxies /v1 to the API)
```

---

## Docker

```bash
docker compose up --build
```

`docker-compose.yml` mounts `./data` for the database and artifacts and reads
`.env`. The image includes `yt-dlp`, `ffmpeg` and `tesseract`, so the caption,
audio and OCR-fallback paths work out of the box.

```bash
docker build -t ai-enhancement-app .
docker run -d --name aiapp -p 4000:4000 \
  -v "$PWD/data:/app/data" --env-file .env \
  --restart unless-stopped ai-enhancement-app
```

---

## Hosting it for real

Anywhere that runs a Node process with a persistent disk: a $5 VPS, Fly.io,
Railway, Render, or a home server behind a tunnel.

**HTTPS is required, not optional.** The Web Share Target API and service workers
only work on secure origins, so without TLS you lose one-tap capture — the
product's entire point. `localhost` is exempt for development.

### Behind Caddy (simplest correct TLS)

```caddy
aiapp.example.com {
    reverse_proxy localhost:4000
}
```

### Behind nginx

```nginx
server {
    listen 443 ssl http2;
    server_name aiapp.example.com;

    ssl_certificate     /etc/letsencrypt/live/aiapp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aiapp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Artifact exports can be large.
    client_max_body_size 32m;
}
```

The app sets `trust proxy`, so rate limiting keys on the real client IP behind
either.

### systemd

```ini
[Unit]
Description=AI Enhancement App
After=network.target

[Service]
Type=simple
User=aiapp
WorkingDirectory=/opt/ai-enhancement-app
EnvironmentFile=/opt/ai-enhancement-app/.env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=always
RestartSec=5

# The process only ever needs its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/ai-enhancement-app/data

[Install]
WantedBy=multi-user.target
```

---

## Production checklist

**Before exposing it to the internet:**

- [ ] `NODE_ENV=production` and a long random `JWT_SECRET`. The server **refuses
      to boot** in production with the published default — that check is there
      because forging tokens against a known secret is trivial.
- [ ] TLS terminated in front of the app.
- [ ] `PUBLIC_URL` set to the real HTTPS origin (used in notification links and
      CORS).
- [ ] `ALLOW_SIGNUP=false` once your accounts exist, for a personal deployment.
- [ ] `data/` on persistent storage, backed up.
- [ ] Budget ceilings (`MAX_USD_PER_LINK`, `MAX_USD_PER_USER_PER_DAY`) set to
      numbers you are comfortable paying if something loops.
- [ ] `MEDIA_RETENTION_DAYS` matching your privacy posture.

**Rotating `JWT_SECRET` invalidates all sessions and makes stored connector
secrets undecryptable** — the encryption key is derived from it. Re-enter
connectors after a rotation, or move to a managed KMS first.

---

## Backups

Everything durable is under `data/`:

```
data/
├── aiapp.sqlite        # jobs, specs, decisions, runs, users, audit
├── artifacts/          # per-user folders — the actual deliverables
└── storage/            # cached media
```

SQLite in WAL mode must be backed up with its journal, or use the online backup
API:

```bash
sqlite3 data/aiapp.sqlite ".backup '/backups/aiapp-$(date +%F).sqlite'"
tar czf "/backups/artifacts-$(date +%F).tar.gz" data/artifacts
```

Losing `data/` loses history. It does not lose the *work* if you have been
running the desktop bridge — that is a second copy on your own machine.

---

## Getting artifacts onto your desktop

### Desktop bridge (recommended)

On the machine where you want the files:

```bash
BRIDGE_API_URL=https://aiapp.example.com \
BRIDGE_TOKEN=<access token> \
BRIDGE_DEST="~/Desktop/AI Enhancement App" \
npm run bridge
```

Dependency-free Node, polls every 60s, writes only inside `BRIDGE_DEST`, and
needs no inbound connection. `--once` does a single sync.

Get a token by signing in and reading `localStorage["aiapp.tokens"]`, or:

```bash
curl -s -X POST https://aiapp.example.com/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'
```

### Or just download

Settings → **Export everything** gives the whole tree as a zip. Nothing to
install, works from any device.

---

## Scaling past one box

The pieces to replace, in the order they will hurt:

1. **Database.** SQLite handles a household comfortably. Past that, port
   `src/repo/*` to Postgres — the repository layer is the only thing that
   touches SQL.
2. **Queue.** `src/queue/queue.ts` is a lease-based table. Swap for SQS/Redis/
   Temporal behind the same `enqueue` / `claim` / `complete` / `fail` interface.
   Workers are already stateless and idempotent, so run as many as you like.
3. **Object storage.** Point `STORAGE_PATH` at a mounted volume, or replace
   `fileManager.ts` with S3.
4. **Separate worker processes.** Set `WORKER_CONCURRENCY=0` on API instances and
   run the worker separately, so heavy ASR/OCR jobs never make the API slow.

---

## Cost

With the offline analyzer: **zero**. Everything runs locally.

With Claude and speech-to-text, per link:

| Path | Typical cost |
| --- | --- |
| Caption available (YouTube) | ~$0.01–0.05 — analysis tokens only |
| Audio ASR, 60s clip | ~$0.006 ASR + analysis |
| Carousel, 6 multimodal slides | ~$0.02–0.08 |

The cheapest-path-first waterfall plus content-hash caching keeps this down: a
re-shared link costs nothing, and audio is only downloaded when no caption track
exists. Per-link and per-user-per-day ceilings are enforced before each paid
stage, and Settings shows live spend.
