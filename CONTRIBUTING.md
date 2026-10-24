# Contributing

This is a standalone Hermes Desktop UI plugin. Keep contributions scoped to public SDK APIs and include regression tests for behavior changes.

## Checks

Run `npm test` and `npm run check`. No third-party npm dependencies or build step are required. Node v26.7.0 and npm 12.0.2 were used for the initial checks. If available, also run `hermes plugins validate . --json`.

Tests load the actual ESM entry with SDK/React doubles. They prove the mocked contracts, not Windows/Electron behavior. UI changes need a separate manual Desktop check. Report the Desktop version and commit, operating system, source/target route topology and the steps that reproduce a problem. Do not upload real conversations, credentials, raw environment dumps or personal project trees; prefer minimal synthetic fixtures.

## Boundaries

- Preserve full `(connectionId, profile)` routing and backend mapping; never infer routes from display names.
- Preserve unknown ownership instead of substituting the active profile.
- Do not modify a source session, submit messages, call models or transfer drafts/attachments.
- Use only public SDK interfaces and the plugin's own subtree/styles; no private imports, core patches, DOM lookups or direct database writes.
- Reject unconfirmed project identity instead of guessing a folder/project.
- Keep context copying explicit, bounded and attributed; keep briefs local and extractive.
- Preserve operation liveness checks, create idempotency, read-back and honest partial-failure notices.
- Do not introduce install scripts, backend services, secret storage or analytics as incidental changes.

Hermes/SDK/React are provided by the host and are not vendored here. Contributions are expected under the repository's MIT license. Do not include third-party code without checking its license and preserving required notices.
