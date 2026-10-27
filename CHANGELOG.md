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
- Confirmed synthetic Home membership permits no-project chats; a blank folder alone never proves Home.
- Missing source rows require strict live identity/idle/empty fields and an independent zero-message transcript before a plain empty new chat is allowed, even beyond a full 200-row lookup page. Hydrating saved chats are not classified empty from the live row alone. Unpersisted drafts do not inherit a project; the different-profile choice dialog is retained.
- Named glyph colors delegate to public SDK profileColor/profileColorSoft helpers with a neutral fallback; no custom palette or private avatar lookup.
- Named glyphs in the composer and menu match native ProfileGlyph sizing and typography: a 1rem square, 0.5rem semibold letter, centered with unit line-height and no shrinking. The outer button, spacing and colors are unchanged; the tester reported the visual correction applied successfully on Windows.
- Latched source-drift checks cancel abandoned early plain-new-chat/dialog actions, including navigation away and back during the initial roster read.
- Full source/target mappings are refreshed after the final history/project read and immediately before create; focus/lifecycle is checked again so stale mappings do not receive the copied seed.
- 461 tests covering the actual entry with SDK/React doubles, empty-source/Home/hydration guards, native colors and named-glyph geometry, late mapping/cancellation guards, documented media-filtering limits and metadata contracts; syntax and Hermes catalog admission validation pass.
- Catalog preparation: matching package/manifest version `0.1.0`, conservative Hermes floor `>=0.22.2`, MIT/public repository metadata and Git/deep-link/manual installation instructions.
- User-reported Windows smoke checks and subsequent successful-test feedback are recorded separately from automated source/SDK-double checks. The consolidated catalog candidate is not independently Electron-certified.

This entry describes the prepared source snapshot, not a GitHub release announcement. Other Desktop builds/platforms are not certified. Multi-folder/worktree/ambiguous project structures, guest replies inside the source chat, model calls, automatic submission and draft/attachment transfer are outside this version.
