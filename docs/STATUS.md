# Build status

What is built, what is deliberately not, and what to do next.

Last updated: 2026-09-29.

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
    (or a grounded application experiment when the source is not instructional)
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
| **P0 — Personal MVP** | PWA + paste, media extraction, useful spec, approval, implementation, desktop filing | **In progress.** Capture/review are strong; local private-content sign-in now exists, but several implementation types still stop at an artifact or reminder. |
| **P1 — Robust single-user** | Multimodal OCR, broad source coverage, trust controls, browser automation, push | **In progress.** Core controls exist; live provider setup and a real platform test matrix are still required. |
| **P2 — Broadly shareable** | Accounts, isolation, real connectors, cost controls, privacy, operations | **Not complete.** Account isolation and user-scoped extraction caches are implemented. Hosted social auth, connector OAuth, managed secrets and production operations remain release blockers. |

## Deliberately not built

Each of these is a decision, not an omission. Full reasoning in
[TRACEABILITY.md](TRACEABILITY.md).

- **Native iOS/Android app.** The PWA covers the same share-target capability
  without store review. The backend is client-agnostic, so a React Native client
  is additive.
- **Connector OAuth flows.** The model, encrypted storage and prerequisite
  matching exist. The UI no longer marks a connector present with a fake secret;
  each provider still needs a real registered app and callback flow.
- **Team/organization accounts.** Marked *Could* / Phase 2 in both documents.
- **Executing shell commands.** `run_command` prepares and explains; it does not
  run. Handing arbitrary shell to an autonomous loop is not a capability worth
  having here.
- **Hosted social sign-in.** Local mode opens a headed browser and stores the
  resulting session encrypted. A multi-tenant hosted service still needs an
  isolated browser/session provider before this can be enabled safely.

## Known limitations

Honest ones, worth knowing before relying on this:

- **Instagram and TikTok need live media providers to do well.** Without ASR
  and vision, audio and on-screen text cannot be understood. The job is now
  marked as a processing/configuration failure rather than “no insight.”
- **The offline analyzer is a genuine fallback, not a Claude substitute.** It
  reliably finds imperative, well-formed advice. It will miss a tip phrased
  obliquely, and it cannot author a rich skill body the way the model can.
- **Private content works only where the connected account can view it and the
  platform extractor accepts that session.** Deleted, DRM-protected or revoked
  content remains a typed extraction failure.
- **The scheduler fires notifications, it does not run arbitrary work.** A
  `schedule_task` item registers a real recurring task that reminds you at the
  right time; wiring a schedule to an *action* needs the connector for that
  action.
- **SQLite means one writer.** Fine for individuals and small teams; see the
  scaling notes in [DEPLOYMENT.md](DEPLOYMENT.md).

## Test coverage

131 tests across seven suites:

| Suite | Covers |
| --- | --- |
| `extraction.test.ts` | URL handling, subtitle parsing incl. rolling-window auto-captions, normalization, confidence and rule-based extraction |
| `pipeline.test.ts` | Capture → spec → approve → implement, artifact layout, carousel/audio paths, user-scoped caching, terminal-job retry and zip export |
| `security.test.ts` | Auth, refresh rotation, enumeration resistance, rate limits, per-user isolation, path traversal, erasure, scope containment, trust dial, dry-run, failure isolation, audit completeness, SSRF and command blocklists, budgets |
| `units.test.ts` | Cron parsing/next-run/description, zip structure, lenient JSON recovery, model-path analyzer incl. server-side scope assignment, markdown escaping |
| `personalization.test.ts` | Profile invariants, triage, universal capture, pathways, confirmation and life-domain safety |
| `agentic.test.ts` | Tool-use implementation, reversibility, permission denial and audit coverage |
| `openai.test.ts` | OpenAI-compatible analysis and tool-calling transport |

```bash
npm test
```

## Suggested next steps

Roughly in order of value:

1. Configure a live model, speech-to-text and vision provider, then run a saved
   public/private link matrix across every supported platform.
2. Make the desktop bridge a verified action worker for real skills,
   instructions and scheduled work.
3. Implement the first real connector OAuth flow and remove that connector from
   the release-blocker list only after token validation and an end-to-end action.
4. Add extraction success/error metrics and alerts by platform before inviting
   external users.
5. Follow the staged release gates in [COMMERCIALIZATION.md](COMMERCIALIZATION.md).
