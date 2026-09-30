# AI Enhancement App

Share any link you believe could improve your life or work. The app retrieves
the post, video, audio, image or page; works out what is different from your
current setup; produces a concrete implementation or learning experiment; and,
for the items you approve, carries out the bounded work it can do.

This is a working implementation of the **AI Enhancement App** described in the
[Business Requirements Document](docs/AI_Enhancement_App_BRD.docx) and
[Technical Specification](docs/AI_Enhancement_App_Technical_Spec.docx) in `docs/`.

![System architecture](docs/architecture.png)

---

## The problem it solves

Discovery happens in *consume mode* — a good Claude tip scrolls past at 11pm.
Acting on it needs *work mode* — sitting down, re-watching, translating advice
into setup. The two almost never coincide, so the saved link becomes a
placeholder for a good intention that decays.

This closes the gap: one tap at the moment of discovery, one keep-or-skip
decision later, and the machine does the rest.

```
capture → understand → analyse & spec → notify → review & decide → implement → file artifacts
```

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
| Just do the safe ones *(default)* | Skills, instructions and generated files run on approval; schedules, downloads and connectors ask again |
| Just do it | Everything you approve runs immediately |

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
- **It does not act outside your own environment.** Autonomous implementation is
  confined to approved scopes, generated artifacts and tools you explicitly connect.

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
├── server/          API, orchestrator, ingestion, analysis, implementation engine
├── web/             the PWA — capture, review, digest, settings
└── desktop-bridge/  dependency-free CLI that syncs folders to your desktop
docs/                architecture, API, deployment, traceability, source documents
scripts/             icon generation
```

## Tests

```bash
npm test
```

92 tests covering the extraction waterfall (captioned video, rolling-window
auto-captions, silent carousels, audio-only clips), analyzer fidelity including
the grounded-application fallback, the full capture → spec → approve → implement
loop, per-user isolation, path traversal, scope containment, dry-run, budgets
and audit completeness. The suite also verifies that extraction caches cannot
leak a private transcript across users.

## Licence

MIT — see [LICENSE](LICENSE).
