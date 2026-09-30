# AI Enhancement App — current handoff

Updated 2026-09-29.

## Product direction

Paste or share any post, video, audio clip, image or web page that seems worth
learning from. The product must retrieve the content, understand the useful
idea, compare it with the user's actual life/work context, and produce a
concrete implementation or learning experiment. Retrieval failure is a product
failure or authentication requirement—never “no insight found.”

## Repository state

- Branch: `claude/shadirenno-sparkit-app-dqyff1`
- Remote: `https://github.com/Shadirenno-Sparkit/AI_enhancement-.git`
- Monorepo: shared types, Express/SQLite server, React/Vite PWA and desktop bridge
- Required Node version: 20.11+
- Development server now uses `tsx`, so `npm run dev` works on current Node.

Validation commands:

```bash
npm install
npm run build
npm run typecheck
npm test
npm audit
```

Current baseline: 92 tests pass; build and typecheck pass; `npm audit` reports
zero known vulnerabilities.

## Changes in the current working tree

- Retrieval with zero usable segments now ends in `NEEDS_INPUT` (authentication)
  or `FAILED` (extraction/configuration), with `failureCode` and `requiredAction`.
  It no longer ends in `NO_ACTION`.
- Terminal jobs are explicitly reset before rerun; previously a state guard
  silently prevented retries from leaving `FAILED` or `NEEDS_INPUT`.
- Successfully retrieved content always yields an item. Direct advice becomes
  an implementation item; non-instructional content becomes a grounded
  application note and labelled small experiment.
- Extraction caches are user-scoped. The previous global URL cache could reuse
  one customer's private transcript or shared caption for another customer.
- Local one-time sign-in is implemented for YouTube, Instagram, TikTok, X,
  LinkedIn and Facebook. The encrypted Playwright storage state is materialized into mode-0600
  browser and `yt-dlp` files for one extraction and deleted afterward.
- Settings and blocked-job review screens expose the social sign-in/retry flow.
- The connector screen no longer writes the literal secret `configured` and
  pretends OAuth succeeded.
- Production dependencies were updated and the audit is clean.
- `docs/COMMERCIALIZATION.md` now defines alpha, beta and paid-GA gates.

## Running the useful local path

```bash
cp .env.example .env
npx playwright install chromium
# Configure at least one live model/vision provider and ASR provider in .env.
npm run build
npm start
```

Open `http://localhost:4000`, create an account, describe the user's real tools
and routine in Settings, and connect any private social account under **Private
social content**. The local sign-in flow opens a visible browser on the same
computer as the server.

## Commercial blockers still open

1. **Hosted private-content authentication.** `local_browser` is an owner-alpha
   implementation, not a multi-tenant SaaS design. Use an isolated remote
   browser/session broker before enabling it in a hosted service.
2. **Closed-loop implementation.** `create_skill` is agentic; several other item
   types still produce artifacts, connector records or reminders rather than
   completing the intended real-world action.
3. **Real connector OAuth.** Provider registration, callbacks, refresh/revoke
   handling and token validation remain unbuilt.
4. **Scheduling that performs work.** Scheduled tasks currently notify; they do
   not execute the saved action.
5. **Production operations and key management.** SQLite/local disk and
   JWT-derived secret encryption are suitable for an owner alpha, not paid SaaS.
   See `docs/COMMERCIALIZATION.md` for the full gates.

## Next engineering priority

Make the desktop bridge a bidirectional, verified action worker:

- install approved skills into the user's real skill directory;
- append approved standing instructions to the real instruction file;
- install a genuine OS schedule whose action is the approved task; and
- report execution results and undo data to the server.

That work closes more of the product promise than adding another dashboard or
another nominal item type.
