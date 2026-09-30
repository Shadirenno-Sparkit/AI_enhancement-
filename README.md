# AI Enhancement App

Capture anything you run into — a link, a thought you type, something you
overheard and dictate, or a photo of a page. The app retrieves and reads the
source, works out the delta against what it knows about *you*, offers grounded
routes for putting it to use, and carries out the bounded work you approve.

This is a working implementation of the **AI Enhancement App** described in the
[Business Requirements Document](docs/AI_Enhancement_App_BRD.docx) and
[Technical Specification](docs/AI_Enhancement_App_Technical_Spec.docx) in `docs/`.

![System architecture](docs/architecture.png)

---

## The problem it solves

Discovery happens in *consume mode* — a good idea scrolls past at 11pm, or
someone mentions a book while you are getting coffee. Acting on it needs *work
mode*: sitting down, re-reading, translating advice into setup. The two almost
never coincide, so the saved link becomes a placeholder for a good intention
that decays.

This closes the gap: one tap at the moment of discovery, one keep-or-skip
decision later, and the machine does the rest.

```
capture → understand → triage → plan against your profile → review routes → implement → file artifacts
```

### What makes it more than a summarizer

The app holds a **life context graph** — what you own, what you subscribe to,
how you prefer to read, what you are working towards. Every plan is written
against it, so the same book recommendation becomes *"get the audiobook, you
have an unused Audible credit and a 40-minute drive"* rather than *"consider
reading this book"*.

Three properties follow from that, and each is enforced rather than intended:

- **Nothing is assumed about you.** Facts the analyzer notices while reading a
  capture are queued as proposals and stay out of every prompt until you accept
  them. A guess can never overwrite something you stated.
- **Personalization is auditable.** An item that claims "because you prefer X"
  must name a profile key you actually hold, or the claim is dropped before it
  reaches the screen.
- **The last step stays yours.** No item type can complete a purchase or send a
  message, because no such permission scope exists to grant. `acquire_media`
  prepares an order, `contact_person` writes a draft, `financial_review` writes
  questions.

### What it costs to use

Capturing is cheap on purpose. A cheap triage pass reads every capture and
decides whether a full plan is worth the spend; entertainment stops there at
zero cost, and anything it rates below your threshold rests one tap away under
**Plan this**. Only what matters pays for the expensive pass.

---

## Quickstart

The text-link path runs without API keys using the built-in analyzer. Processing
speech and text inside videos requires a live ASR/vision provider (or local
Whisper/Tesseract), and private social content requires a connected session.
The app reports missing capability as a processing problem; it does not call an
unread link "nothing actionable."

```bash
git clone <this repo> && cd AI_enhancement-
npm install
cp .env.example .env
npx playwright install chromium
npm run build
npm start
```

Open <http://localhost:4000>, create an account, and paste a link on the
**Capture** tab.

For development with hot reload:

```bash
npm run dev     # API on :4000, PWA on :5173
```

### Turning on the full pipeline

| Add to `.env` | What it unlocks |
| --- | --- |
| `ANTHROPIC_API_KEY=sk-ant-…` | Claude does the insight extraction, spec writing and artifact authoring instead of the rule-based analyzer |
| `ASR_PROVIDER=openai` + `OPENAI_API_KEY=…` | Speech-to-text for clips with no caption track (most Reels and TikToks) |
| `VISION_PROVIDER=claude` | Reads text baked onto images and carousel slides |
| `yt-dlp` on `PATH` | Author captions, auto-captions and audio download — the cleanest, highest-fidelity extraction path |
| `ffmpeg` on `PATH` | Frame sampling so on-screen text in videos gets read |
| `ENABLE_BROWSER_AGENT=true` + `npx playwright install chromium` | Renders JavaScript-heavy pages and enables local one-time social sign-in |
| `AUTO_PLAN_THRESHOLD=0` | How good a capture must look before it is planned without asking. `0` plans everything; raise it to trade automation for lower model spend |

Every one of these is optional and independently useful. The **Settings** screen
shows exactly which are live on your deployment, so the app is always honest
about what will happen to a link.

### Private posts and one-time sign-in

In a local deployment, Settings → **Private social content** opens a separate
Playwright browser window for YouTube, Instagram, TikTok, X, LinkedIn or Facebook. Sign
in once, then confirm in the app. The encrypted browser session is materialized
only for the duration of an extraction and supplied to both the rendered-page
path and `yt-dlp`; temporary cookie files are deleted afterward.

For a hosted commercial deployment, set `SOCIAL_AUTH_MODE=disabled` until an
isolated remote-browser/session broker is configured. A headed browser on the
server host is a useful local MVP, not a safe multi-tenant SaaS authentication
architecture. See [commercialization readiness](docs/COMMERCIALIZATION.md).

---

## One-tap capture from your phone

The PWA registers as a **Web Share Target**. Install it to your home screen and
"AI Enhancement App" appears in the normal share sheet inside Instagram, TikTok,
YouTube, X, LinkedIn and Facebook.

- **iOS (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** menu → *Install app*

Share targets require an installed PWA served over HTTPS (or localhost). The
service worker handles the share **offline**: it queues the link on-device and
submits it when connectivity returns, so a capture is never lost.

Android frequently delivers the shared link inside the `text` field rather than
`url`, and iOS often sends `"caption text… https://link"`. Both are handled — the
app pulls the URL out of whatever field it lands in.

---

## What you get per link

Every processed link produces one folder under a single `AI Enhancement App/`
folder, exactly as specified in §11.1 of the technical spec:

```
AI Enhancement App/
├── _index.md                          # every link, with status
├── _instructions.md                   # standing instructions accumulated across links
├── _settings.md                       # setting changes with exact steps
├── _skills/                           # reusable skills, ready to drop into Claude Code
└── 2026-07-30__instagram__morning-inbox-summary/
    ├── 00_source.json                 # url, platform, capture time, shared text
    ├── 01_transcript.vtt              # captions/subtitles when time-coded
    ├── 01_transcript.txt              # normalized plain text
    ├── 02_extracted-insights.json     # every segment, with provenance + confidence
    ├── 03_summary.md                  # plain-English "what this post tells you to do"
    ├── 04_spec.md                      # the technical spec for this link
    ├── 05_implementation-plan.md      # itemised plan + methods + prerequisites
    ├── 06_decisions.json              # your per-item approve/forgo choices
    ├── 07_run-log.md                  # every autonomous action taken + result
    ├── artifacts/                     # generated files, downloads, created skills
    └── media/                         # cached audio / frames (retention-limited)
```

Three ways to get these onto your machine:

1. **Desktop bridge** — `npm run bridge` on your own computer. Polls and writes
   the folders to `~/Desktop/AI Enhancement App`. No inbound connection needed.
2. **Export everything** — one button in Settings, downloads the whole tree as a zip.
3. **Per-link zip** — from any link's detail screen.

---

## You stay in control

Nothing runs until you check it. Each proposed improvement is a separate
approve/skip decision, **defaulting to unselected**, with the source excerpts it
was drawn from shown inline so you can check the claim before agreeing to it.

Past that gate, the **trust dial** decides what happens:

| Posture | Behaviour |
| --- | --- |
| Ask me every time | Approval alone never runs anything |
| Just do the safe ones *(default)* | Skills, instructions, habits and generated files run on approval; schedules, orders, drafts and connectors ask again |
| Just do it | Everything you approve runs immediately |

When the dial holds something, **Yes, run it** releases that item on that run
only — confirming one purchase never loosens the posture for the next.

Plus a **Preview** button that computes what would change without changing it,
an **Undo** on anything reversible, and a run log recording every action.

The engine only ever holds the permissions an item's *type* implies, recomputed
server-side — a model response cannot widen what a run is allowed to touch. It
refuses fetches to private/loopback addresses, never executes shell commands
(it prepares and explains them for you to run), and confines every write to your
own artifact folder.

---

## Product contract

Stated plainly, because both source documents are explicit about it:

- **A retrieved link always produces a useful path.** Direct advice becomes an
  implementation plan. Commentary or entertainment becomes a grounded
  application note and small experiment; the app labels its inference instead
  of pretending the creator gave advice they did not give.
- **A retrieval failure is never called “no insight.”** Missing authentication,
  provider setup, unsupported media and extractor failures are typed,
  actionable product states and remain visible until retried or fixed.
- **Private content uses the user's own authorized session.** The app does not
  bypass access controls, DRM or platform restrictions. Deleted content,
  revoked access or a platform extractor breakage can still fail, but that is
  reported as an acquisition failure—not a judgment about the content.
- **It never invents advice.** When a source contains no direct instruction, the
  app labels its grounded application note and reversible experiment as its own
  proposal, not as something the creator said.
- **It never spends your money or speaks for you.** Items that touch commerce
  prepare an order and hand you the link; items that touch people write a draft
  you send yourself. There is no permission scope in the system that completes a
  purchase or sends a message, so no approval — however permissive — can reach
  one.
- **It does not give financial, medical or legal advice.** A `financial_review`
  item produces a checklist of questions to take to your own accounts or a
  professional. It never reads an account and never moves money.
- **It does not build a profile of you behind your back.** Everything it infers
  is shown to you for confirmation first, and the whole graph is visible and
  deletable on the **You** tab.

---

## Documentation

| Document | What's in it |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the seven layers map onto the code |
| [docs/API.md](docs/API.md) | Every endpoint, with request/response shapes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, hosting, HTTPS, backups, hardening |
| [docs/TRACEABILITY.md](docs/TRACEABILITY.md) | Every BRD requirement → where it is implemented and tested |
| [docs/STATUS.md](docs/STATUS.md) | What is genuinely built and what remains incomplete |
| [docs/COMMERCIALIZATION.md](docs/COMMERCIALIZATION.md) | Release gates from local alpha through paid GA |

---

## Repository layout

```
packages/
├── shared/          types, URL/folder-naming rules, markdown renderer
├── server/          API, orchestrator, ingestion, triage, analysis, implementation engine
├── web/             the PWA — capture, profile, review, digest, settings
└── desktop-bridge/  dependency-free CLI that syncs folders to your desktop
docs/                architecture, API, deployment, traceability, source documents
scripts/             icon generation
```

## Tests

```bash
npm test
```

The 131-test suite covers the extraction waterfall (captioned video, rolling-window
auto-captions, silent carousels, audio-only clips), analyzer fidelity including
the grounded-application fallback, the full capture → triage → plan → approve →
implement loop, per-user isolation, path traversal, scope containment, dry-run,
budgets, audit completeness, and prevention of cross-user extraction-cache leaks.

The personalization layer carries its own suite: that an inferred fact never
overwrites a stated one and never reaches a prompt unconfirmed, that the profile
brief stays inside its token budget, that triage refuses to let a `no_action`
verdict become a false "no insight" result, that no item type holds a scope capable of
spending money or sending a message, that confirming a held item leaves the
trust posture untouched, and that the generated n8n workflow imports as a
connected graph with unique node ids.

## Licence

MIT — see [LICENSE](LICENSE).
