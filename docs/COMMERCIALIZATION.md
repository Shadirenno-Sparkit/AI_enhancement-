# Commercialization readiness

Last updated: 2026-09-29.

This document separates a convincing local product from a safe, supportable
paid service. Passing the automated test suite is necessary; it is not the same
as being ready to accept customer money.

## Non-negotiable product contract

1. A captured link is durable and retryable.
2. Successfully retrieved content always produces at least one grounded outcome:
   a direct implementation or a clearly labelled application experiment.
3. Failure to retrieve content is never reported as “no insight.” It is a typed
   authentication, configuration, budget or extraction failure.
4. Private content is accessed only with the user's authorized session. The app
   does not bypass access controls or imply it can read content the user cannot.
5. Nothing acts outside the scopes attached to an item the user approved.
6. Tenant data—including extraction caches and social sessions—never crosses
   account boundaries.

## Current readiness

| Area | Current state | Commercial status |
| --- | --- | --- |
| Capture, queue, retries, artifact filing | Implemented and tested | Alpha-ready |
| Text/caption/ASR/OCR extraction waterfall | Implemented; quality depends on configured providers and platform extractors | Beta with monitoring |
| Private social content | One-time encrypted session works for a local deployment and feeds Playwright + `yt-dlp` | **Hosted release blocker** |
| Analysis → life/work delta | Uses personal context; direct-advice and grounded-application paths implemented | Alpha-ready; needs real-user evals |
| Approval, scopes, audit, undo | Implemented and tested | Beta-ready |
| Real-world implementation | `create_skill` is agentic; several other item types still produce artifacts or records rather than closing the loop | **Paid-release blocker** |
| Tool connectors | Data model exists; OAuth is not implemented and the UI no longer fakes a connection | **Paid-release blocker** |
| Recurring tasks | Scheduler records and notifies; it does not yet execute the intended action | **Paid-release blocker** |
| Multi-tenant privacy | User-scoped reads and caches; encrypted connector/session secrets | Needs external security review and managed key storage |
| Dependencies | Production and development audit currently reports zero known vulnerabilities | Maintain continuously |
| Deployment | Single-node Docker/SQLite deployment | Suitable for owner alpha, not broad SaaS |

## Release gates

### Gate A — owner-operated alpha

- Configure live analysis, speech-to-text and vision providers.
- Keep `SOCIAL_AUTH_MODE=local_browser`; install Playwright Chromium.
- Run a platform matrix against public and private examples from every supported
  source and retain the extraction evidence.
- Make the desktop bridge install skills, instructions and schedules in their
  real destinations rather than only mirroring artifacts.
- Add structured extraction metrics: success rate by platform/method, auth
  required rate, empty-segment rate, retry recovery rate and cost per link.

### Gate B — invited multi-user beta

- Replace the local headed-browser login with an isolated remote browser/session
  broker. Each session needs tenant isolation, encryption with a managed key,
  revocation, expiry, reauthentication and an audit trail.
- Complete real OAuth flows for every connector shown in the UI. A connector
  cannot be marked configured without token validation.
- Move artifact downloads away from access tokens in query strings to short-lived
  signed download grants.
- Add database migrations with versioning and rollback; move secrets off the
  JWT signing key so normal key rotation does not destroy connector access.
- Add centralized error reporting, queue dashboards, per-platform alerts,
  support correlation IDs and a documented incident response path.
- Perform threat modeling and independent security/privacy review, including
  SSRF, prompt injection, browser-session theft and cross-tenant access.
- Publish privacy, retention, deletion, acceptable-use and platform-terms
  policies that match the actual behavior.

### Gate C — paid general availability

- Convert every marketed item type into a verified closed-loop action or remove
  it from marketing. In particular, schedules must execute work rather than
  merely send reminders.
- Add entitlements, billing, cancellation, refunds, usage metering and hard spend
  controls that are tested against concurrency and retries.
- Replace SQLite/local disk with production data, queue and object-storage
  services appropriate to the target load, with tested backup restoration.
- Define availability and processing-latency targets; load test the capture API,
  workers and provider degradation paths against them.
- Run real-user quality evaluations for “useful delta” and implementation
  completion, not only extraction accuracy. Track how often users approve,
  modify, complete, revert or abandon each proposed outcome.
- Complete accessibility, browser/device, onboarding, support and data-export
  acceptance testing.

## Private-content architecture decision

The current local flow is intentionally concrete: the server opens Playwright,
the user signs in, storage state is encrypted in the connector store, and each
job decrypts it into mode-0600 temporary files for the browser and `yt-dlp`.
Those files are deleted immediately after fetching, and extraction caches are
scoped to the user.

Do not enable this mode on a remote multi-tenant server. The commercial version
needs the same interface backed by isolated browser workers or a vetted session
provider, with no customer ever seeing or sharing another customer's browser
process, cookies, cache or media.

## Definition of “it always works”

No product can guarantee that a deleted post, revoked permission, DRM stream or
unannounced platform change is readable. The enforceable promise is:

- the app exhausts the configured extraction waterfall;
- it uses the user's authorized session when required;
- it never silently downgrades or mislabels a retrieval failure;
- it tells the user or operator exactly what blocked the job;
- the job remains retryable after the problem is fixed; and
- successfully retrieved content always becomes a concrete next step.
