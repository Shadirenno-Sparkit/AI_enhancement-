# AI Enhancement App — session handoff

Written 2026-07-31. Paste this into a new chat to pick up where we left off.

---

## What this app is

Share a social post → AI extracts the actionable tips → you approve/skip each one →
the engine implements the approved ones → artifacts land in `~/Desktop/AI Enhancement App/`.

Monorepo (npm workspaces): `packages/server` (Express/TS), `packages/web` (React 18 + Vite PWA),
`packages/shared`, `packages/desktop-bridge`. Local clone: `~/Desktop/Shadi Work/AI_enhancement/`.

**Shadi's stated priority:** *"as much automation as possible so I don't have to remember to do things."*
Judge every proposal against that.

---

## How to run it

`npm run dev` is **broken on Node 24** — the server script uses `--experimental-strip-types`,
which doesn't remap `.js` imports to `.ts`. Build first instead:

```bash
npm run build --workspace @aiapp/shared
npm run build --workspace @aiapp/server
npm start                      # server → http://localhost:4000
npm run dev --workspace @aiapp/web   # PWA → http://localhost:5173
```

- Test account: `shadi@test.com` / `testpassword123`
- Auth tokens live in `localStorage` under key `aiapp.tokens` (dot, not underscore)
- Tests: `npm test` (83 passing, ~16s)

---

## Git / GitHub — read this before pushing

- Local branch: `claude/shadirenno-sparkit-app-dqyff1`
- **The gh CLI account `Shadirenno-Sparkit` has read-only access to `shadirenno/AI_enhancement-`.**
  Direct pushes 403. Work lands via a fork:
  - remote `fork` → `https://github.com/Shadirenno-Sparkit/AI_enhancement-.git`
  - open PR: <https://github.com/shadirenno/AI_enhancement-/pull/1>
  - `git push fork claude/shadirenno-sparkit-app-dqyff1` updates the PR automatically
- **Upstream has no `main`.** Its only branch — and its default — is
  `claude/shadirenno-sparkit-app-dqyff1`. Any PR `--base` must name that branch.

---

## Work completed this session (3 commits, all on PR #1)

### 1. `Make the review flow legible: decision-first UX pass`
Front-end only. Design system reorganised around: one decision per card, accent means act,
chrome serves the content.

- Item cards: checkbox → explicit **Skip / Later / Approve** segmented control. The checkbox
  could only express 2 of the 4 real states, so "not looked at" and "deliberately skipped"
  rendered identically.
- Collapsed badge soup (up to 6 pills) to one neutral type chip + a quiet metadata line.
- **Fixed a layout bug:** the action bar stacked on the tab bar, but `.app__main` only padded
  for the tab bar — the last item card sat underneath the approve button.
- Emoji icons → inline SVG (emoji ignore `color`, so active tabs barely looked active).
- Top bar now says where you are and carries the single back affordance.
- Settings grouped into panels; per-link cost removed from the inbox.

### 2. `Make the implement phase actually agentic`
**Two latent bugs meant the Claude path had almost certainly never executed:**
- `ANTHROPIC_MODEL` defaulted to `claude-opus-5` — **not a real model ID**. A live key 404s on
  every call; `completeJson` swallows it and falls back to the offline regex analyzer, while
  Settings still reads "live". Fixed to `claude-opus-4-8` in `config.ts`, `.env`, `.env.example`
  and the `PRICING` table.
- `@anthropic-ai/sdk` was pinned at **0.39.0** (early 2025) — predates adaptive thinking and
  `output_config`. Upgraded to **0.115.0**.

New architecture:
- `providers/llm.ts` — `runAgent()`, a hand-written tool-use loop (deliberately *not* the SDK's
  beta tool runner: the approval gate is the security story and belongs visible in the file).
  Sets `thinking: {type:'adaptive'}` explicitly (off by default on this model family).
- `implementation/tools.ts` — scoped toolsets. `create_skill` became `list_skills` /
  `read_skill` / `write_skill`. The read verbs are the point: the model can check before
  clobbering something you rely on.
- `implementation/agentic.ts` — every tool call gated against the item's sandbox, recomputed
  from item *type* server-side. Denials are audited and the model is told why. Unknown tool
  names are refused + audited too (that's an injection signal from the captured post).
- `engine.ts` tries agentic first, falls back to the deterministic handler.
- `stubAgentLlm` in the test harness walks a scripted plan through the same
  approve → run → record path, so the gate is tested without a key.

**Only `create_skill` is converted. The other 7 handlers are not.**

### 3. `Make ingestion actually see the post`
Triggered by an IG link returning *"No caption track, audio, images or readable page text."*
The cause: **every acquisition path was off or broken simultaneously.**

- **Bug:** `sampleFrames` targeted `<workDir>/video.mp4`, which nothing ever wrote (the media
  pass only downloaded audio). Video frames were never sampled — OCR could only see the
  OpenGraph thumbnail.
- **Bug:** the frame step was also gated behind `audioPath === undefined && imagePaths.length === 0`,
  which a thumbnail or an audio download each falsified. Together: unreachable.
- **Fix:** when frames are wanted, yt-dlp downloads the video once (720p cap), ffmpeg samples it,
  and audio is extracted from that same file rather than downloaded twice.
- **Instagram:** IG returns an empty media response to signed-out clients for essentially every
  Reel — its own error message says to pass cookies. Added `YTDLP_COOKIES_FROM_BROWSER` /
  `YTDLP_COOKIES_FILE`, threaded through all three yt-dlp calls, **off by default**.
- **Test hygiene:** with yt-dlp installed the suite started making real network calls for every
  fixture URL (17s → 69s). Harness now points `YTDLP_BIN`/`FFMPEG_BIN` at unresolvable names.

Installed this session via Homebrew: **yt-dlp 2026.07.04**, **ffmpeg 8.1.2**.
Verified end to end: download → 12-frame sample → mp3 extraction all work.

---

## Current state — what actually works vs. doesn't

| Capability | State |
|---|---|
| Capture, pipeline, guardrails, scopes, audit, undo | Genuinely well built |
| Analysis quality | **Offline regex only** — no API key set |
| On-screen text (OCR) | `VISION_PROVIDER=claude`, but needs `ANTHROPIC_API_KEY` |
| Speech → transcript | **`ASR_PROVIDER=stub` — a literal no-op** |
| Video frames / audio download | Fixed + tooling installed ✅ |
| Instagram | Needs `YTDLP_COOKIES_FROM_BROWSER=chrome` (or safari/firefox) |
| `create_skill` implementation | Agentic ✅ |
| Other 7 handlers | Still one fixed `fs.writeFile` each |
| `schedule_task` | **Fires a push notification. Automates nothing.** |
| Desktop bridge | One-way file downloader. 244 lines, no exec. |
| Connectors | `revealConnectorSecret()` is dead code; UI stores the literal string `'configured'` |

---

## The three things blocking the product's promise

1. **No API key.** `ANTHROPIC_API_KEY` is empty in `.env`; no `ant` profile, no env var.
   Nothing agentic and no OCR can run until this is set. This is the single biggest unlock —
   it also flips analysis from regex to real extraction.
2. **`ASR_PROVIDER=stub`.** Speech is never transcribed. Options: `openai` (needs
   `OPENAI_API_KEY`, ~$0.006/min), or `whisper-local` (free, needs `brew install whisper-cpp`
   + a model download, slower).
3. **`schedule_task` doesn't schedule anything.** It calls `notify()` — the exact
   "remember to do it yourself" thing Shadi wants gone.

---

## Agreed next step (not started)

**Make the desktop bridge bidirectional.** It currently only pulls files down. Turning it into
an action worker is what closes the last mile:

- `create_skill` writes to `~/.claude/skills/` (where Claude Code actually reads) instead of `~/Desktop/`
- `set_instruction` appends to the real `CLAUDE.md`
- `schedule_task` installs a genuine **launchd** job — real automation, not a reminder

**Architecture decision already made:** tool-calling loop in the Express server + bidirectional
bridge — **not** Managed Agents. Rationale: 6 of 8 item types need Shadi's actual Mac
(`~/.claude/skills`, `CLAUDE.md`, launchd), so a cloud sandbox can't close the last mile; MA is
beta and its self-hosted sandboxes still lack env-var vaults and memory stores. MA stays the
later hosted tier. The handlers-become-tools refactor is a prerequisite either way, so it's not
wasted work.

---

## Known issues worth fixing sometime

- `effort` and `impact` on every item are a **static lookup on item type** in
  `analysis/heuristics.ts` (`EFFORT_BY_TYPE` / `IMPACT_BY_TYPE`). "Reusable skill" *always*
  reads "low effort, high impact". Those UI values carry no real signal.
- Uncommitted in the working tree: `packages/desktop-bridge/src/bridge.js` has a file-mode
  change only (644→755), and `package-lock.json` churn. Both harmless.
- A published artifact showing the UI walkthrough exists at
  <https://claude.ai/code/artifact/05b41c66-6b96-41ba-a21c-4d2895b1bb82>

---

## Fastest path to seeing this work properly

```bash
# 1. Add a key — unlocks real analysis AND on-screen text reading
#    edit .env → ANTHROPIC_API_KEY=sk-ant-...

# 2. Let it see Instagram (uses your own logged-in session; read the
#    ToS note at the top of ingestion/fetcher.ts first)
#    edit .env → YTDLP_COOKIES_FROM_BROWSER=chrome

# 3. Optional — transcribe speech
#    edit .env → ASR_PROVIDER=openai  + OPENAI_API_KEY=sk-...

npm run build --workspace @aiapp/shared && npm run build --workspace @aiapp/server && npm start
```

Then share the same IG link again. With a key + cookies it should pull the Reel, sample frames,
read the on-screen text, and produce a real spec instead of "Nothing to act on."
