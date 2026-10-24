# Changelog

## 0.1.0 — initial publication candidate

- Compact, native-style profile menu next to the composer `+`.
- Global focused-chat owner indicator with default/home, named/initial and neutral unknown/draft states.
- Connection-qualified route selection with fresh revalidation.
- Context-choice dialog: Copy context, Brief handoff, Start fresh and Cancel.
- Bounded visible-history copying with source attribution and truncation notices.
- Local extractive brief without a model call.
- Verified single-folder project/cwd inheritance on the same gateway, including automatic groups, empty target projects and historical main-checkout branch groups.
- Explicit no-inherited-project notice for cross-gateway or cross-mode handoffs.
- Durable session read-back, stable per-operation idempotency, open-only retry and lifecycle guards.
- Collision-resistant operation keys across reloads/windows, using browser Web Crypto with explicit refusal when entropy is unavailable.
- Late focus-drift guards and prompt cleanup, including navigation away and back during suspended RPCs.
- Explicit mount-local recovery of known created sessions with no new create/title/history transfer.
- Best-effort filtering of recognisable projected/structured media, including media glued to neighbouring text without a separator; every ordinary HTTP link is preserved, so complete exclusion of attachment references is not guaranteed.
- The connection-qualified route is re-read and revalidated after awaited reads and immediately before every open attempt.
- 220 tests covering the actual entry with SDK/React doubles, documented media-filtering limits and metadata contracts; syntax and Hermes catalog admission validation pass.
- Catalog preparation: matching package/manifest version `0.1.0`, conservative Hermes floor `>=0.22.2`, MIT/public repository metadata and Git/deep-link/manual installation instructions.
- Windows checks of the three choices, project inheritance, cancellation and source preservation reported successful by the tester before pre-publication hardening; the subsequent changes still need Windows retesting.

This entry describes the prepared source snapshot, not a GitHub release announcement. Other Desktop builds/platforms are not certified. Multi-folder/worktree/ambiguous project structures, guest replies inside the source chat, model calls, automatic submission and draft/attachment transfer are outside this version.
