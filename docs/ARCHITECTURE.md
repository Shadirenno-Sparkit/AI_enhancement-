# Architecture

How the seven layers of the [Technical Specification](AI_Enhancement_App_Technical_Spec.docx)
map onto this codebase.

![System architecture](architecture.png)

---

## Shape of the system

A thin capture client, an asynchronous cloud pipeline, an autonomous
implementation engine, and a desktop artifact sink.

```
PWA / share target
   │  POST /v1/links          (returns immediately)
   ▼
Link inbox ──► job_queue ──► worker
                               │
                               ├─ resolve platform
                               ├─ fetch media (yt-dlp / HTTP / browser)
                               ├─ transcript waterfall (captions → ASR → OCR → DOM)
                               ├─ normalize into one InsightSource
                               ├─ analyse (Claude, or rule-based fallback)
                               ├─ write spec + artifacts
                               └─ notify "spec ready"
                                        │
                              user reviews, approves per item
                                        │
                               ├─ trust dial / guardrails
                               ├─ per-item handler inside a scope sandbox
                               ├─ run log + audit log
                               └─ artifacts filed to disk
```

Four properties drive most of the design decisions below:

- **Capture is sacred.** `POST /v1/links` persists and returns; it never waits on
  processing and never fails because a worker is busy.
- **Cheapest reliable path first.** Every stage tries the cheap method and
  escalates only on failure or low confidence.
- **Everything is a job.** Durable, resumable, idempotent, with retries.
- **Human gate, machine execution.** One decision per item; bounded, logged and
  reversible autonomy past that gate.

---

## Layer 1 — Capture

| Spec component | Code |
| --- | --- |
| Shared Capture SDK | `packages/web/src/shareQueue.ts` |
| PWA share target | `packages/web/public/manifest.webmanifest`, `public/sw.js` |
| Manual paste fallback | `packages/web/src/pages/Capture.tsx` |
| URL extraction | `packages/shared/src/url.ts` |

The service worker *is* the capture layer. It intercepts the share-target POST,
extracts a URL from whichever field the OS used, queues it in IndexedDB, and
redirects to a confirmation screen — all without needing the network. The page
supplies the access token on the next launch and the queue flushes.

`extractUrl` handles the two shapes that actually arrive in practice: Android
putting the link in `text`, and iOS sending `"caption… https://link"`.

A native React Native / Expo client would slot in here unchanged: it hits the
same `POST /v1/links` and renders the same review data. The PWA path is the one
that needs no app-store review, so it is the one implemented.

## Layer 2 — Edge & orchestration

| Spec component | Code |
| --- | --- |
| API Gateway + Auth | `src/app.ts`, `src/api/middleware.ts`, `src/api/routes/auth.ts` |
| Link Inbox & Job Queue | `src/repo/jobs.ts`, `src/queue/queue.ts` |
| Processing Orchestrator | `src/orchestrator/pipeline.ts` |
| Notification Service | `src/notifications/notify.ts` |

**Auth** is OAuth2-style bearer tokens: short-lived JWT access tokens plus
single-use rotating refresh tokens. Every user-scoped route sits behind
`requireAuth`, and every repository read takes the resolved `userId` — that
pairing is what makes per-user isolation hold even if a handler forgets to check
ownership itself.

**The queue** is a SQLite table with lease-based claiming:

```sql
UPDATE job_queue SET status='leased', lease_owner=?, leased_until=?
 WHERE queue_id = (SELECT queue_id FROM job_queue
                    WHERE run_after <= ?
                      AND (status='pending' OR (status='leased' AND leased_until < ?))
                    ORDER BY queue_id LIMIT 1)
```

SQLite serializes the write, so exactly one worker wins the lease. A crashed
worker's lease expires and its job becomes claimable again — that is how
"restarts resume cleanly" is achieved without a workflow engine. Retries use
exponential backoff (5s → 30s → 2m → 10m); only after they are genuinely spent
does the user see a failure.

**Dedupe** is `hash(userId + normalizedUrl)`, so re-sharing the same Reel from a
different app with different tracking params folds into the original job rather
than paying to process it twice.

## Layer 3 — Ingestion & understanding

| Spec component | Code |
| --- | --- |
| Platform Resolver | `packages/shared/src/url.ts` → `resolvePlatform` |
| Media Fetcher | `src/ingestion/fetcher.ts` |
| Transcript Engine | `src/ingestion/transcript.ts`, `src/ingestion/subtitles.ts` |
| Vision / OCR | `src/providers/vision.ts` |
| Content Normalizer | `src/ingestion/normalizer.ts` |

This is the hardest part of the system and follows the waterfall from spec §6.2:

| Step | Method | Provenance | Nominal confidence |
| --- | --- | --- | --- |
| 0 | Post caption / description — free, and often *is* the tip | `post_description` | 1.00 |
| 1 | Author-provided subtitles | `author_caption` | 0.99 |
| 2 | Platform auto-captions | `auto_caption` | 0.90 |
| 3 | Audio download → speech-to-text | `asr_whisper` / `asr_hosted` | ~0.88 |
| 4 | Frames / carousel slides → multimodal read | `ocr_multimodal` | 0.95 |
| 4b | Dedicated OCR fallback for clean text | `ocr_tesseract` | 0.82 |
| 5 | Rendered page text, last resort | `browser_dom` | 0.85 |

Steps 3 and 4 run **in parallel, not as alternatives** — a post routinely carries
the tip in the audio, on screen, or both.

Two details matter more than they look:

- **Auto-caption de-duplication.** YouTube auto-captions use a rolling window
  where each cue repeats the previous line plus one new one. Left alone that
  triples the transcript and inflates the item count. `dedupeCues` collapses it.
- **Cross-source de-duplication.** A Reel routinely burns a sentence into the
  video, says it aloud, and repeats it in the caption. Without
  `normalize`'s signature-based dedupe, the analyzer sees one tip three times and
  proposes three "features".

Every segment keeps its provenance and confidence, which is what makes the
review UI able to show *"this item came from these words, read this way, at this
confidence"*.

## Layer 4 — Analysis & spec

| Spec component | Code |
| --- | --- |
| Insight Extractor / Spec Generator / Feature Decomposer | `src/analysis/analyzer.ts` |
| Rule-based fallback | `src/analysis/heuristics.ts` |
| Model access | `src/providers/llm.ts` |

Two interchangeable paths behind one interface:

**With `ANTHROPIC_API_KEY`,** Claude receives the merged, provenance-tagged text
and returns a title, summary, and typed items with rich `parameters` (a full
skill body, the exact instruction sentence, a cron expression).

**Without it,** the rule-based extractor does real work: it scores each sentence
for imperative mood, advice markers, recurrence phrasing and domain vocabulary;
discounts engagement bait and the post's own headline; merges near-duplicates;
classifies each surviving tip into an item type; and emits usable parameters.
This is why the product works out of the box.

Both paths converge on the same guarantee: **items are grounded in the source or
they do not exist.** "No actionable items" is a correct, tested outcome.

Regardless of which path ran, the server always:

- assigns **permission scopes from the item type**, never from the model output;
- computes **missing prerequisites** against the user's actual connectors;
- flags **duplicates** of items the user previously approved.

## Layer 5 — Review & decision

| Spec component | Code |
| --- | --- |
| Approval UI | `packages/web/src/pages/Review.tsx` |
| Decision & Preference Log | `src/repo/specs.ts` → `decisions`, `decisionStatsByType` |

Each item renders with its checkbox **unselected** (opt-in), its effort/impact,
its risk tier, what the engine will do, what permissions that needs, any missing
prerequisite, and the source excerpts it was drawn from.

Decisions are logged with timestamps and rolled up per item type, which feeds
both the digest's preference profile and future ranking.

## Layer 6 — Autonomous implementation

| Spec component | Code |
| --- | --- |
| Implementation Engine | `src/implementation/engine.ts` |
| Item handlers | `src/implementation/handlers.ts` |
| Guardrails & sandbox | `src/implementation/guardrails.ts` |
| Scheduler | `src/implementation/cron.ts`, `src/queue/worker.ts` |
| Connectors | `src/repo/connectors.ts` |

Each item type maps to a least-privilege scope set:

| Type | Risk | Scopes |
| --- | --- | --- |
| `create_skill` | safe | `artifacts:write`, `skills:write` |
| `set_instruction` | safe | `artifacts:write`, `instructions:write` |
| `generate_file` | safe | `artifacts:write` |
| `schedule_task` | moderate | `artifacts:write`, `schedule:write` |
| `configure_setting` | moderate | `artifacts:write`, `instructions:write` |
| `download_file` | moderate | `artifacts:write`, `net:read`, `browser:operate` |
| `connect_tool` | sensitive | `artifacts:write`, `connectors:read/write` |
| `run_command` | sensitive | `artifacts:write`, `shell:exec` |

The sandbox **recomputes scopes from the item type** rather than reading the
stored column, so a tampered database row or a model claiming extra permissions
grants nothing. A handler reaching for a scope its type does not carry throws
`ScopeViolation`, which is caught, audited, and contained to that one item.

Two containment properties are enforced in the engine rather than the handlers,
so no handler can opt out:

- **Failure isolation** — an item that throws produces `not_possible` for itself
  and nothing else.
- **Blast radius** — writes are confined to the user's artifact root, downloads
  refuse private/loopback addresses, and `run_command` *prepares and explains*
  rather than executing.

## Layer 7 — Artifacts & storage

| Spec component | Code |
| --- | --- |
| File Manager | `src/artifacts/fileManager.ts` |
| Index writer | `src/orchestrator/index-writer.ts` |
| Metadata DB | `src/db/schema.sql` |
| Audit Log | `src/repo/audit.ts` |
| Desktop bridge | `packages/desktop-bridge/src/bridge.js` |

Folder names are `YYYY-MM-DD__platform__short-title`. The folder must exist
before analysis (every earlier stage writes into it), so it is created from
whatever title the fetch produced and **renamed once analysis yields a real
one** — that rename is what makes the folder list browsable without opening
anything.

Every path used as a filesystem component is validated against the user's root
before any write.

## Cross-cutting

| Concern | Where |
| --- | --- |
| Security & privacy | `middleware.ts` (auth, rate limits), `connectors.ts` (AES-256-GCM at rest), `users.ts` (erasure) |
| Observability | `util/logger.ts` (structured, auto-redacting), `GET /v1/metrics` |
| Cost control | `guardrails.ts` budgets, `usage_daily` roll-up, per-provider pricing tables |
| Config & secrets | `config.ts` — refuses to boot in production with the default `JWT_SECRET` |

---

## Deliberate deviations from the specification

Stated openly so reviewers can judge them.

**SQLite instead of a separate relational DB, queue broker and cache.** The spec
calls for Postgres + a broker + Redis. For the deployment scale this product
actually has (individuals and small teams), one SQLite file in WAL mode provides
the same durability, transactional guarantees and lease semantics with zero
operational surface — you can run the whole product with `npm start`. The
repository layer is the seam: swapping in Postgres and a real broker means
reimplementing `src/repo/*` and `src/queue/queue.ts`, not touching the pipeline.

**The Agent SDK is not a runtime dependency.** The spec names the Claude Agent
SDK as the implementation engine. That harness expects the Claude Code CLI to be
present, which would make the product unrunnable for anyone who has not
installed it. Instead the engine implements the same *contract* — bounded task
per item, explicit permission scope, lifecycle hooks, run log — against typed
handlers, and calls Claude directly for content authoring. `HANDLERS` in
`handlers.ts` is the seam where an Agent SDK driver drops in per item type.

**Browser automation is opt-in.** Playwright is ~300MB installed. It is loaded
dynamically and absent by default; without it, the HTTP page-text path covers
most of the same ground.

**Connectors are recorded, not OAuth-negotiated.** Real OAuth flows need
registered apps and callback URLs per provider. The connector model, encrypted
secret storage, prerequisite matching and the `connect_tool` handler are all
built; what a production deployment adds is the per-provider OAuth dance in
`api/routes/users.ts`.
