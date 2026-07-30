# Build status

What is built, what is deliberately not, and what to do next.

Last updated: 2026-07-30.

---

## The loop works end to end

Verified against a running build, not just in tests:

```
share/paste a link
  → URL extracted from whatever field it arrived in
  → platform resolved, content fetched
  → transcript waterfall (captions → ASR → OCR → page text)
  → normalized into one InsightSource with provenance + confidence
  → analysed into a summary and typed, approvable items
  → notified
  → per-item approve / skip / defer
  → approved items implemented inside a permission sandbox
  → nine artifacts filed into a dated, titled folder
  → index rewritten, run log written, every action audited
```

A worked run reproducing the BRD's own Appendix A example produces exactly the
three items that document predicts (`create_skill`, `schedule_task`,
`set_instruction`), in source order, with the right risk tiers — and approving
items 1 and 3 while skipping 2 writes a usable skill file and a standing
instruction to disk.

## Phase coverage

Against the phasing in BRD §16 / spec §17:

| Phase | Target | State |
| --- | --- | --- |
| **P0 — Personal MVP** | PWA + paste, YouTube + one of IG/TikTok, captions + ASR, summary + itemised spec, manual approval, safe autonomous items, desktop foldering | **Complete**, and past it — all six platforms, all eight item types |
| **P1 — Robust single-user** | Multimodal OCR, X/LinkedIn/Facebook, trust dial, dry-run, run logs, browser automation, native app + push | **Complete except the native app.** Push is implemented (VAPID); the native client is deferred |
| **P2 — Broadly shareable** | Accounts, isolation, per-user connectors and destinations, cost controls, quotas, privacy and deletion, value-adds | **Complete except org/team grouping and store distribution.** Weekly digest, duplicate detection and preference learning are in |

## Deliberately not built

Each of these is a decision, not an omission. Full reasoning in
[TRACEABILITY.md](TRACEABILITY.md).

- **Native iOS/Android app.** The PWA covers the same share-target capability
  without store review. The backend is client-agnostic, so a React Native client
  is additive.
- **Connector OAuth flows.** The model, encrypted storage and prerequisite
  matching exist; per-provider OAuth needs registered apps and callback URLs.
- **Team/organization accounts.** Marked *Could* / Phase 2 in both documents.
- **Executing shell commands.** `run_command` prepares and explains; it does not
  run. Handing arbitrary shell to an autonomous loop is not a capability worth
  having here.
- **Signing in on your behalf.** The browser agent extracts content; it does not
  take custody of your credentials.

## Known limitations

Honest ones, worth knowing before relying on this:

- **Instagram and TikTok need keys to do well.** Neither exposes a caption
  track, so without `ASR_PROVIDER` and `VISION_PROVIDER` configured you get the
  post caption and little else. The app says so plainly rather than degrading
  silently.
- **The offline analyzer is a genuine fallback, not a Claude substitute.** It
  reliably finds imperative, well-formed advice. It will miss a tip phrased
  obliquely, and it cannot author a rich skill body the way the model can.
- **Private and age-gated content will not resolve.** By design.
- **The scheduler fires notifications, it does not run arbitrary work.** A
  `schedule_task` item registers a real recurring task that reminds you at the
  right time; wiring a schedule to an *action* needs the connector for that
  action.
- **SQLite means one writer.** Fine for individuals and small teams; see the
  scaling notes in [DEPLOYMENT.md](DEPLOYMENT.md).

## Test coverage

77 tests across four suites:

| Suite | Covers |
| --- | --- |
| `extraction.test.ts` | URL handling, subtitle parsing incl. rolling-window auto-captions, normalization and cross-source dedupe, confidence flagging, rule-based extraction incl. the "nothing actionable" case |
| `pipeline.test.ts` | Capture → spec → approve → implement, artifact layout, folder naming, dedupe, carousel and audio-only paths, caching, idempotent reprocessing, zip export |
| `security.test.ts` | Auth, refresh rotation, enumeration resistance, rate limits, per-user isolation, path traversal, erasure, scope containment, trust dial, dry-run, failure isolation, audit completeness, SSRF and command blocklists, budgets |
| `units.test.ts` | Cron parsing/next-run/description, zip structure, lenient JSON recovery, model-path analyzer incl. server-side scope assignment, markdown escaping |

```bash
npm test
```

## Suggested next steps

Roughly in order of value:

1. **Add `ANTHROPIC_API_KEY`.** Single biggest quality jump — real insight
   extraction and authored skill bodies rather than restated source text.
2. **Add speech-to-text.** Unlocks Reels and TikToks, which is where most of
   this content actually lives.
3. **Run the desktop bridge.** Turns the artifacts into files on your machine
   you can open, and gives you a second copy of everything.
4. **Deploy behind HTTPS and install the PWA.** This is when it stops being a
   web app and starts being the thing described in the BRD — one tap, mid-scroll.
5. **Wire one real connector.** Whichever one your tips keep asking for, most
   likely email or GitHub.
6. **Then consider the native app**, if iOS share-sheet behaviour proves limiting
   in practice.
