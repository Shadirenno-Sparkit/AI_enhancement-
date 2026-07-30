# Requirements traceability

Every business requirement from BRD §8, mapped to where it is implemented and
where it is verified.

**Status key:** ✅ implemented · ◐ partially implemented (scope noted) ·
⬚ deliberately out of scope

---

## Capture (BRD §8.1)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-C1 | One-tap share-sheet capture, no fields | ✅ | `web/public/sw.js` share-target handler, `manifest.webmanifest` `share_target` | `extraction.test.ts` "pulls a URL out of shared text" |
| BR-C2 | Native app **and** installable PWA | ◐ | PWA fully implemented. Native iOS/Android deferred — see note 1 | — |
| BR-C3 | Manual paste fallback | ✅ | `web/src/pages/Capture.tsx` | `pipeline.test.ts` capture flow |
| BR-C4 | Capture text shared alongside the link | ✅ | `shared/src/url.ts` `stripUrl`, `POST /v1/links` `sharedText` | `extraction.test.ts` |
| BR-C5 | Instant visual acknowledgement, no further interaction | ✅ | SW redirects to `#/captured`; `POST /v1/links` returns before processing | — |
| BR-C6 | Optional one-line note or tag *(Could)* | ✅ | `note` field on capture, fed to the analyzer as `user_note` | — |
| BR-C7 | Queue offline captures, submit on reconnect | ✅ | IndexedDB queue in `sw.js`, `shareQueue.ts` flush on load/online/sync | — |

## Understanding (BRD §8.2)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-U1 | Retrieve full transcript/captions | ✅ | `ingestion/fetcher.ts` yt-dlp pass, `ingestion/subtitles.ts` | "prefers author captions over auto captions" |
| BR-U2 | Fall back to speech-to-text | ✅ | `providers/asr.ts` (OpenAI/Whisper-local/AssemblyAI/Deepgram), waterfall step 3 | "falls back to speech-to-text when no caption track exists" |
| BR-U3 | Read text-on-image and carousels | ✅ | `providers/vision.ts` multimodal + Tesseract fallback | "reads a text-on-image carousel through the vision path" |
| BR-U4 | Incorporate the post's own caption | ✅ | Waterfall step 0 → `post_description` | "deduplicates the same tip arriving from caption, audio and OCR" |
| BR-U5 | Record extraction method + confidence, flag low results | ✅ | `Provenance` + per-segment confidence; `lowConfidence` in `normalizer.ts` | "flags thin extractions from lossy sources", "does not cry wolf over a short but verbatim caption" |
| BR-U6 | YouTube, Instagram, TikTok, X, LinkedIn, Facebook | ✅ | `resolvePlatform` + per-platform strategy | "classifies every platform in the coverage matrix" |
| BR-U7 | Degrade gracefully with a clear message | ✅ | `describeFailure` in `transcript.ts`; `NO_ACTION` with an explanation | "reports plainly when nothing can be extracted" |

## Analysis & specification (BRD §8.3)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-A1 | Extract every distinct tip | ✅ | `analysis/analyzer.ts` (Claude) + `heuristics.ts` (offline) | "extracts the real tips and ignores engagement bait" |
| BR-A2 | Plain-English summary | ✅ | `summaryPlainEnglish` → `03_summary.md` | `pipeline.test.ts` artifact assertions |
| BR-A3 | Technical spec of what Claude must do | ✅ | `renderTechnicalSpec` → `04_spec.md` | `pipeline.test.ts` |
| BR-A4 | Decompose into independently approvable items | ✅ | Typed `SpecItem[]`, one decision each | "never runs an item the user did not approve" |
| BR-A5 | Enough context per item to decide quickly | ✅ | `why`, `proposedMethod`, effort/impact, risk tier, `sourceExcerpts` | `GET /v1/specs/:id` shape |
| BR-A6 | Flag items needing a tool the user lacks | ✅ | `findMissingPrerequisites` against real connectors | "assigns scopes server-side and ignores what the model claims" |
| BR-A7 | Detect duplicates already implemented *(Could)* | ✅ | `markDuplicates` vs `previouslyApprovedItems` | — |
| — | **Never fabricate advice** | ✅ | Grounding rules in both paths; `noActionableItems` | "finds nothing actionable in pure entertainment", "returns no items for pure entertainment" |

## Review & decision (BRD §8.4)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-R1 | Notify when a spec is ready | ✅ | `notifications/notify.ts` `notifySpecReady` (in-app, push, email) | — |
| BR-R2 | Per-item approve/forgo, **defaulting to unselected** | ✅ | `pages/Review.tsx` — checkbox seeded from stored decision, else off | "never runs an item the user did not approve" |
| BR-R3 | Approve all / forgo all / any subset in one screen | ✅ | Bulk actions + per-item control | — |
| BR-R4 | Log every decision with timestamp | ✅ | `decisions` table, unique per item; `decisionStatsByType` | "records every autonomous action in the audit log" |
| BR-R5 | Light edits before approving *(Could)* | ✅ | `edits` on the decision, shallow-merged over item parameters | — |
| BR-R6 | Defer without losing it *(Could)* | ✅ | `defer` decision; surfaces in digest and library | — |

## Autonomous implementation (BRD §8.5)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-I1 | Implement approved items autonomously | ✅ | `implementation/engine.ts` + typed handlers | "runs the full approve → implement loop" |
| BR-I2 | Use connectors and a browser agent when needed | ◐ | Connector model + `connect_tool`; browser agent opt-in via Playwright — see note 3 | — |
| BR-I3 | Bounded permission model, no out-of-scope actions | ✅ | `sandboxFor` recomputes scopes from item type; `ScopeViolation` | "gives each item type only the scopes it declares" |
| BR-I4 | Record every autonomous action | ✅ | `RunAction[]` + append-only `audit_log` → `07_run-log.md` | "records every autonomous action in the audit log" |
| BR-I5 | Schedule recurring/deferred work | ✅ | `schedule_task` handler, `cron.ts`, worker tick | `units.test.ts` cron suite |
| BR-I6 | Revert an implemented item where feasible *(Should)* | ✅ | Recorded undo steps, `POST …/revert/:itemId` | "reverts a reversible item" |
| BR-I7 | Clear per-item result | ✅ | `done`/`partial`/`needs_input`/`not_possible`/`skipped`/`dry_run` + one-line summary | "isolates a failing item from the rest of the run" |

## Artifacts & organization (BRD §8.6)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-F1 | One subfolder per link under `AI Enhancement App/` | ✅ | `artifacts/fileManager.ts`, desktop bridge | "captures a link, files artifacts…" |
| BR-F2 | Source, transcript, insights, summary, spec, plan, run log | ✅ | `ARTIFACT_FILES` — all nine files | `pipeline.test.ts` asserts each file exists |
| BR-F3 | Meaningful folder names | ✅ | `YYYY-MM-DD__platform__short-title`, renamed after analysis | "produces browsable folder names"; folder-name assertion in `pipeline.test.ts` |
| BR-F4 | Top-level index of all links and status | ✅ | `_index.md` via `rebuildIndex` | `pipeline.test.ts` index assertion |

## Accounts & sharing (BRD §8.7)

| ID | Requirement | Status | Implementation | Verified by |
| --- | --- | --- | --- | --- |
| BR-S1 | Individual accounts with secure auth | ✅ | bcrypt(12), JWT access, rotating single-use refresh, rate limits | "rotates refresh tokens single-use", "does not leak whether an email exists" |
| BR-S2 | Per-user isolation of links, artifacts, credentials | ✅ | `user_id` on every table and every query; artifact root per user | "never exposes one user's links, specs or artifacts to another", "confines artifact reads" |
| BR-S3 | Per-user connectors and desktop destination | ✅ | `connectors` table (AES-256-GCM), `preferences.desktopFolder`, bridge | — |
| BR-S4 | Team/organization grouping *(Could)* | ⬚ | Not built — see note 4 | — |

---

## Non-functional requirements (BRD §11)

| Area | How it is met |
| --- | --- |
| Simplicity | One tap, zero fields, instant confirmation; capture returns before any processing |
| Performance | Fully asynchronous; capture confirms in well under 1s; cheapest-path-first + content-hash caching |
| Availability | Capture persists before enqueue; offline queue on-device; leases make crashed jobs re-runnable |
| Usability & accessibility | Mobile-first, one-handed (actions at thumb height), 44px+ targets, visible focus rings, `prefers-reduced-motion`, labelled controls, AA-contrast pairs in light and dark |
| Transparency | Provenance and confidence per segment; source excerpts per item; full run log and audit trail; `/v1/capabilities` states what is actually live |
| Security & privacy | TLS-first, encrypted connector secrets, per-user isolation, auto-redacting logs, user-initiated erasure, media retention purge |
| Legal / compliance | Only what a platform serves to a signed-out viewer; no paywall/DRM/private-gate circumvention; SSRF-blocked downloads |
| Cost control | Per-link and per-user-per-day ceilings enforced before paid stages; per-provider pricing tables; live spend in Settings |
| Reliability of autonomy | Scope sandbox, dry-run, failure isolation, recorded undo, append-only audit |

## Success metrics (BRD §5)

The digest computes these from real data — `GET /v1/digest`:

| Metric | Where |
| --- | --- |
| Capture-to-action rate | `captureToActionRate` — links with ≥1 approved item ÷ links captured |
| Capture effort | 1 tap, 0 required fields (by construction) |
| Extraction confidence | `overallConfidence` per link; low-confidence list in the digest |
| Autonomous completion rate | Run item statuses, rolled up in `implemented` / `needsYou` |
| Backlog | `awaitingReview` |
| Cost | `totals.usd` |

---

## Notes on partial and out-of-scope items

**1 — Native mobile app (BR-C2).** The PWA implements the same share-target
capability without app-store review, and is the phase-0 deliverable in both
documents' rollout plans. A React Native / Expo client would reuse this backend
unchanged: it posts to the same `POST /v1/links` and renders the same
`GET /v1/specs/:id`. What it adds is an iOS Share Extension and Android
`ACTION_SEND` filter — genuinely useful on iOS, where PWA share targets are the
weakest, but it requires Apple/Google developer accounts and store review, which
is a distribution task rather than a build task.

**2 — Speech-to-text and vision are off by default.** Both are fully
implemented behind provider interfaces with four and two backends respectively.
They are off by default because they cost money per link. `.env.example`
documents exactly what to set, and Settings shows what is live.

**3 — Browser automation (BR-I2).** Implemented behind `ENABLE_BROWSER_AGENT`,
loaded dynamically so Playwright's ~300MB is not forced on every install. The
extraction path (rendering JS-heavy pages) works today. Driving a *sign-in* flow
is a different problem — it needs credential custody the security model
deliberately avoids, so `connect_tool` resolves to `needs_input` with setup steps
rather than pretending to have signed in for you.

**4 — Team/organization model (BR-S4).** Marked *Could* in the BRD and Phase 2
in both rollout plans. The data model is already per-user throughout, so adding
an `org_id` alongside `user_id` is additive rather than a restructure.

**5 — Connector OAuth.** The connector model, encrypted storage, prerequisite
matching and the `connect_tool` handler are built. What a production deployment
adds is the per-provider OAuth dance, which needs registered apps and callback
URLs per provider — configuration rather than architecture.

---

## Open questions from the source documents

Both documents end with open questions. Where this implementation takes a
position, it is recorded here.

| Question | Position taken |
| --- | --- |
| Q1 — Desktop sync mechanism | **Both.** A dependency-free polling bridge (no inbound connection, writes only inside the destination) *and* a zip export for people who would rather not run anything. |
| Q2 — Platform priority beyond YouTube | Instagram and TikTok first — they are the hardest (no caption tracks) and the highest-volume for this content, so the ASR + OCR paths are built and tested rather than stubbed. |
| Q3 — Default trust posture | **Balanced**: safe items (skills, instructions, generated files) auto-implement on approval; anything that schedules, downloads, connects or executes asks again. Configurable per user. |
| Q4 — ASR / multimodal providers | Provider-agnostic with four ASR backends and two vision backends. Whisper-class is the documented default on cost; nothing is hard-wired. |
| Q5 — Notification channel | In-app always (it cannot fail), push and email opt-in, with quiet hours batching to prevent the fatigue risk in BRD R7. |
| Q6 — Retention | Raw media purged after `MEDIA_RETENTION_DAYS` (default 14); derived text kept. User-initiated erasure removes everything and de-identifies the audit log rather than destroying it. |
| Q7 — Org/team model | Deferred to Phase 2, as both documents propose. |
