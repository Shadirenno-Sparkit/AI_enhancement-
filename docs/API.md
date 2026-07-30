# API reference

RESTful, JSON, OAuth2-style bearer auth. Base path `/v1`.

All timestamps are ISO-8601 UTC. All money values are USD.

## Authentication

Send `Authorization: Bearer <accessToken>` on every user-scoped request.

Access tokens are short-lived (`ACCESS_TOKEN_TTL`, default 1h). Refresh tokens
are **single-use and rotating**: each refresh invalidates the token you sent and
returns a new one, so a stolen refresh token has a bounded life.

The artifact download endpoints also accept `?access_token=` in the query
string, because a browser navigation (a download link, a share-target redirect)
cannot set headers.

### `POST /v1/auth/signup`

```json
{ "email": "you@example.com", "password": "at least 10 chars", "displayName": "Optional" }
```

→ `201` `{ user, accessToken, refreshToken, expiresIn }`

Rejected with `403` when `ALLOW_SIGNUP=false` — except for the very first
account, so a fresh deployment is always usable.

### `POST /v1/auth/login`

```json
{ "email": "you@example.com", "password": "…" }
```

→ `200` `{ user, accessToken, refreshToken, expiresIn }`

Wrong password and unknown email return an identical `401` body, and take
comparable time, so the endpoint does not disclose which emails have accounts.
Rate limited to 5 attempts, refilling at one per 30 seconds.

### `POST /v1/auth/refresh`

```json
{ "refreshToken": "…" }
```

→ `200` `{ user, accessToken, refreshToken, expiresIn }`

### `POST /v1/auth/logout` · `GET /v1/auth/me`

Logout revokes every refresh token for the user. `me` returns the user plus a
usage roll-up.

---

## Capture

### `POST /v1/links`

The endpoint that must never feel slow. Persists the submission and returns
immediately; all processing happens on the queue.

```json
{
  "url": "Best tip I've seen https://www.instagram.com/reel/Cabc123/",
  "sharedText": "optional caption text shared alongside",
  "note": "optional one-line steer for the analysis",
  "captureSource": "share_target",
  "clientRef": "optional client id for offline retry"
}
```

`url` is **not** validated as a strict URL — the share sheet delivers free text
with a link inside it, and the server extracts the URL from whatever it gets.
Anything left over becomes context.

→ `202` `{ "jobId": "job_…", "state": "RECEIVED", "deduped": false }`
→ `200` with `"deduped": true` when this URL was already captured; the existing
  job is returned rather than reprocessing.

Errors: `400` no link found in the input · `402` daily budget reached ·
`429` rate limited (60 burst, 1/s sustained — generous, so an offline queue
flushing a backlog sails through).

### `GET /v1/library?limit=100`

→ `{ entries: LibraryEntry[] }` — every captured link with state, item counts,
folder path, low-confidence flag and cost.

### `GET /v1/jobs/{jobId}`

Poll a link through the pipeline.

```json
{
  "job": { "state": "TRANSCRIBED", "statusMessage": "Got the content…", … },
  "specId": null, "itemCount": 0, "decidedCount": 0,
  "runId": null, "runStatus": null,
  "lowConfidence": false,
  "progress": 55
}
```

States: `RECEIVED → RESOLVED → FETCHED → TRANSCRIBED → NORMALIZED → ANALYZED →
SPEC_READY → AWAITING_DECISION → IMPLEMENTING → DONE`, plus terminal `PARTIAL`,
`NEEDS_INPUT`, `NO_ACTION`, `FAILED`.

### `POST /v1/links/{jobId}/rerun`

Re-extract, bypassing the cache and forcing the heavier path. This is the
"re-run with a stronger method" escape hatch for a low-confidence result.

### `DELETE /v1/links/{jobId}`

Removes the job and its artifact folder.

---

## Review & decide

### `GET /v1/specs/{specId}`

Everything the review screen needs in one call.

```json
{
  "spec": {
    "title": "Morning inbox summary",
    "summaryPlainEnglish": "This Reel recommends…",
    "technicalSpec": "# Technical specification\n…",
    "noActionableItems": false,
    "items": [{
      "itemId": "item_…",
      "title": "Create a reusable 'morning inbox summary' routine",
      "type": "create_skill",
      "why": "Automates a task you do manually",
      "proposedMethod": "Define a skill…",
      "prerequisites": ["email connector"],
      "missingPrerequisites": ["email connector"],
      "effort": "low", "impact": "high",
      "riskTier": "safe",
      "scopes": ["artifacts:write", "skills:write"],
      "requiresBrowser": false,
      "decision": null,
      "duplicateOfItemId": null,
      "sourceExcerpts": [
        { "order": 3, "text": "Set a standing instruction to…",
          "provenance": "author_caption", "confidence": 0.99 }
      ],
      "autonomy": { "autoImplement": true, "dryRun": false, "reason": "…" },
      "affinity": { "approve": 4, "forgo": 1, "defer": 0 }
    }]
  },
  "job": { … },
  "extraction": {
    "overallConfidence": 0.93, "lowConfidence": false,
    "methodsUsed": ["author_caption", "ocr_multimodal"],
    "language": "en", "durationSec": 47, "segmentCount": 12
  },
  "run": null
}
```

`sourceExcerpts` is the grounding trail — the exact words each item was drawn
from, how they were read, and how much to trust that reading.

### `POST /v1/specs/{specId}/decisions`

The human gate. Nothing has run before this call.

```json
{
  "items": [
    { "itemId": "item_1", "decision": "approve" },
    { "itemId": "item_2", "decision": "forgo" },
    { "itemId": "item_3", "decision": "defer", "edits": { "cron": "0 8 * * 1-5" } }
  ],
  "dryRun": false
}
```

`decision` is `approve` | `forgo` | `defer`. `edits` shallow-merge over the
item's parameters for this run only.

→ `202`

```json
{ "runId": "run_…", "awaitingConfirmation": ["item_5"], "dryRun": false }
```

`awaitingConfirmation` lists approved items the trust dial held back for a
second confirmation, so the UI can ask rather than silently doing nothing.

Every decision is logged with a timestamp regardless of outcome.

### `GET /v1/runs/{runId}`

```json
{
  "run": {
    "status": "done", "overall": "done", "dryRun": false,
    "items": [{
      "itemId": "item_1", "title": "…", "type": "create_skill",
      "status": "done",
      "summary": "Created the reusable skill 'morning-inbox'…",
      "actions": ["Created skill 'morning-inbox'"],
      "artifacts": ["artifacts/morning-inbox.md", "_skills/morning-inbox.md"],
      "reversible": true, "needsInput": null
    }],
    "actions": [{ "at": "…", "itemId": "item_1", "action": "created skill",
                  "detail": "_skills/morning-inbox.md", "scope": "skills:write", "ok": true }],
    "startedAt": "…", "finishedAt": "…"
  }
}
```

Per-item status is `done` | `partial` | `needs_input` | `not_possible` |
`skipped` | `dry_run`. A failure of one item never affects another.

### `POST /v1/specs/{specId}/revert/{itemId}`

Replays the item's recorded undo steps. → `{ "reverted": true, "steps": [...] }`

---

## Artifacts

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/artifacts/{jobId}/files` | List the files in a link's folder |
| `GET /v1/artifacts/{jobId}/file?path=03_summary.md` | Stream one file |
| `GET /v1/artifacts/{jobId}/export` | That link's folder as a zip |
| `GET /v1/artifacts/export/all` | The whole `AI Enhancement App/` tree as a zip |

The `path` parameter is resolved and re-checked against the job folder, so `..`
segments cannot read outside the user's own tree.

---

## User, preferences & connectors

| Endpoint | Purpose |
| --- | --- |
| `PATCH /v1/users/me/preferences` | Trust posture, quiet hours, notification channels, weekly digest, always-preview |
| `GET /v1/users/me/usage` | Spend today and total, against configured ceilings |
| `GET /v1/users/me/audit` | The immutable action trail for this account |
| `DELETE /v1/users/me/data?keepAccount=true` | Erase every link, spec, decision, run and artifact |
| `GET/PUT/DELETE /v1/users/me/connectors[/{kind}]` | Manage connectors — secrets are stored encrypted and never returned |
| `GET/PATCH/DELETE /v1/users/me/schedules[/{taskId}]` | Recurring routines registered by `schedule_task` items |
| `GET /v1/users/me/notifications`, `POST …/read` | In-app notification feed |
| `POST/DELETE /v1/users/me/push-subscription` | Web push registration |

### `GET /v1/digest?days=7`

The weekly digest: totals, capture-to-action rate, what was implemented, what
needs you, what is awaiting review, and the learned preference profile.

---

## Operational

### `GET /health`
`{ "ok": true, "at": "…" }`

### `GET /v1/capabilities`

Unauthenticated. Tells the client which parts of the pipeline are live, so the
UI can be honest about what will happen to a link rather than silently degrading.

```json
{
  "analysis": { "provider": "claude", "live": true },
  "speechToText": { "provider": "openai", "live": true },
  "vision": { "provider": "claude", "live": true },
  "browserAgent": false,
  "autonomousImplementation": true,
  "signupOpen": true,
  "pushPublicKey": "B…",
  "budgets": { "maxUsdPerLink": 0.75, "maxUsdPerUserPerDay": 10 }
}
```

### `GET /v1/metrics`

Queue depth, jobs by state, uptime.

---

## Errors

```json
{ "error": "budget_exceeded", "message": "You have reached your daily processing budget of $10.00. It resets at midnight UTC." }
```

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Validation failed; `details` carries field errors |
| 401 | `unauthorized` | Missing, invalid or expired token |
| 403 | `forbidden` | Signups closed |
| 404 | `not_found` | No such resource **for this user** |
| 402 | `budget_exceeded` | Daily spend ceiling reached |
| 429 | `rate_limited` | Token bucket empty; message says when to retry |
| 500 | `internal_error` | Logged server-side; no internals in the response |

A resource belonging to another user returns `404`, not `403` — the API does not
confirm that an id exists.
