# Usage and compatibility

## Choose a profile

Click the compact indicator next to the composer's `+`, then choose a profile. If identical names exist on different connections, the menu includes the connection qualifier. Route identity is `(connectionId, profile)`, not a display label; the plugin revalidates the target before acting.

The icon follows the **globally focused stored chat**. All split-composer copies display that same readout. A fresh draft or unknown owner uses a neutral indicator instead of inventing an owner from the active gateway.

Named icons use the public SDK's native profile-color helpers, with a neutral theme fallback when those helpers are unavailable. This does not read or promise to reproduce custom avatar/rail overrides.

## Context choices

For a known stored source chat and a different profile, a native dialog asks **Continue with <Profile>?**:

- **Copy context:** read the source history, filter to visible user/assistant text, and seed the new session with source attribution followed by the bounded tail. Up to 20 messages and 12,000 characters are retained. A cap note explains omissions or clipping. Hidden/system/tool rows are excluded. Recognisable attachment-only projections are filtered; captions from mixed text/media can remain. See the media-filtering boundary below: untyped URLs cannot be reliably classified.
- **Brief handoff:** assemble a single user message locally from source identity, folder/project details when available and up to six recent excerpts of 240 characters. This is extractive context, not a model-generated summary. It can omit information needed for a task; review it before relying on it.
- **Start fresh:** create an empty session. The plugin may title its own newly created session to persist it, but does not send a fake message or call a model.
- **Cancel, Escape, backdrop or close button:** abandon the dialog without creating or opening anything.

When the persisted list has no source row, the empty path requires **two independent doors to agree**: a strictly idle and empty live session row with matching runtime/durable ids, and a transcript read for that same session reporting zero messages. A saved chat still hydrating in the background can report the same idle/zero/empty live shape, so the live row alone is never proof. Disagreement, errors or an unavailable door refuse the operation. The different-profile dialog still appears: **Start fresh** opens silently; **Copy context** and **Brief handoff** explain that nothing was carried. This path uses plain new-chat without fake seeds or title writes, and cannot establish an inherited project folder.

Choosing the current profile skips the context-choice dialog and opens a new empty chat with the supported inheritance path. With no confirmed source, missing optional handoff APIs or a proven empty draft, the supported plain new-chat action is used without inherited context. A stored Home chat can still carry selected text through **Copy context** or **Brief handoff**; only project inheritance is absent. Unsupported required SDK exports result in an unavailable control rather than an invented route.

Emptiness verification itself may read the live roster and source transcript even for **Start fresh** or the current profile. Carrying transcript text into another session remains limited to an explicit context choice.

Copying is a deliberate disclosure to the target profile and, for a cross-gateway selection, to the other gateway. The source profile's prior assistant replies remain attributed to that source in the provenance note; they are not newly generated replies by the target. Nothing is automatically submitted. Subsequent user-initiated model requests may include the seeded text and consume model context.

### Media-filtering boundary

The filter removes recognised `@image:` directives, data URIs, legacy image hints and media placeholders. Typed media parts are ignored when structured content is supplied; authored text parts and captions are kept. Both Copy and Brief share that cleaned tail.

Two things are treated as the end of a data-URI payload: explicit base64 padding (`=`/`==`) and a payload that runs to the end of its line. The second is a **heuristic with a known failure mode**: if a caption was glued directly onto an *unpadded* payload and consists only of base64-alphabet characters (`A–Z`, `a–z`, `0–9`, `+`, `/`), it is removed together with the payload — for example `data:image/png;base64,QUJDRAABthanks` loses `thanks`. A caption containing any other character (space, punctuation, non-Latin script) is kept, and a glued payload without such a boundary is left verbatim, so payload text may then appear in the copied chat instead. The flattened projection does not contain enough information to resolve both cases correctly, and the plugin deliberately does not guess further. Review copied context when this matters.

The public history projection can lose the original content type. A plain HTTP URL may be either an ordinary link or a flattened attachment. **All untyped HTTP links are preserved, including standalone image-file links, not guessed away by filename suffix.** They can still refer to media or be recognised as media by the target host. Therefore this plugin does not guarantee that all attachment references are absent from a copied chat. There are no network/content-type probes or hidden downloads to resolve ambiguity.

## Folder and project inheritance

For the same gateway/mode, the plugin reads the source session's persisted folder and verifies source and target project trees. It supports a confirmed single root checkout, named projects and automatic folder groups. Historical main-checkout branch groups and a consistent empty target project are allowed.

**No project (Home) is a confirmed context, not a failure.** The source must belong to the project tree's exact synthetic Home bucket with no path; a blank folder alone is not proof. The new target session opens without an inherited `cwd`.

The plugin refuses ambiguous source membership, a blank folder not claimed by Home, conflicting named projects, malformed groups, multiple folders, worktrees and kanban lanes. It never guesses a project from global UI state. An unavailable/contradictory tree refuses before creation. Lookup is bounded to 200 entries: a missing row does not imply an empty chat, but the two-door empty check runs before the window-limit refusal. Without positive proof the previous refusal remains.

Opening the menu performs no session lookup and opens no chat. The plugin registers no keyboard shortcut; native Ctrl+N is handled by Hermes.

For a different gateway or mode, folder identity is not shared. The new session has **no explicit inherited cwd/project**, and a notice explains that limitation. The selected context option is still honored; a brief can include a source path as text, but the plugin never transfers the folder or its files.

## Failure and retry

The selected full route is refreshed and checked for removal, remapping and ambiguity. Each pending operation watches the three source identity atoms; leaving and returning to the same source does not revive an abandoned intent. Drift before create prevents that write; drift during an accepted create/title/read-back prevents subsequent plugin writes or open/retry calls. A completed create is not rolled back. An `openSession` already accepted by the SDK cannot be cancelled by this watcher and may complete its internal dial/navigation after focus changes. The source guard is cleaned up on completion, unmount and disposal; a new explicit click need not wait for a stale RPC to time out.

The early plain-new-chat path and context dialog also check latched focus drift after roster reads. Before every `session.create`, the full source and target mappings are refreshed together after the last history/project read; lifecycle/focus is checked again after that refresh. Missing, changed, duplicate, malformed or unreadable mappings refuse the write rather than saving a seed to an outdated backend profile. This is not an atomic transaction with host operations already accepted.

Creation uses one cryptographically random per-operation idempotency key, generated through browser Web Crypto rather than a registration-local counter. Without a working entropy source, create is refused. A seeded session receives the chosen messages; an empty one is materialized through a title write to that newly created session only. The plugin reads back the durable session before opening it and retries a failed **open** once, never the create.

A timeout, unreadable read-back, navigation or plugin disposal can happen after the server accepted a create. Therefore a failed or abandoned operation may leave a new target session even when nothing opened. The plugin does not automatically delete it.

When returned runtime/stored IDs are known and the control is still mounted, an explicit **Open created chat with …** action retains that target. It revalidates the connection-qualified route and backend mapping, confirms the durable row/profile/cwd/message count, then opens that exact stored ID with the original history expectation. It never repeats create, title or context transfer. Failed recovery leaves the action available; successful recovery removes it. Ordinary new-chat choices remain new operations, not hidden recovery shortcuts.

Recovery handles are volatile and mount-local: unmount, disable or reload loses them. If a fresh empty create was never durably materialized, recovery cannot open it and will not repeat the title write. An unknown create result without usable IDs has no fabricated recovery. In those cases inspect the target's session list before manually creating another chat.

## What is not changed

- The source session's owner, title and transcript.
- Composer drafts or attachments.
- Profile configuration, credentials, model selection, skills or other plugins.
- Hermes core files, host DOM, private state stores or databases.

The plugin never calls model/submit/steer APIs. It uses the app's authenticated public SDK/gateway routes, so reading history and creating a target session still involve normal backend communication. No third-party analytics endpoint is used.

## Compatibility boundary

The reviewed source target is Hermes Desktop v0.22.2 at `8b66a51036c1e20920a17cdd049fdf55c968d683`. Windows smoke checks of the three actions, project inheritance, cancellation and source preservation were reported by the tester, with subsequent successful-test feedback for the updated plugin. The consolidated catalog candidate has independent source/SDK-double coverage, not an independently retrieved installed Windows digest or automated Electron certification. This experimental plugin does not certify every gateway topology, older/newer build, operating system, keyboard layout or responsive arrangement.

Relevant public interfaces are `profileRoutes`, focused session atoms, `listPersistedSessions`, `requestProfile` for `projects.tree`, `session.active_list`, `session.history`, `session.create` and `session.title`, and `openSession`. Named icon colors use public `profileColor`/`profileColorSoft`. Plain new-chat fallback uses `newChat`. The default export id and installation subfolder must both be `hermes-profile-switcher`; its displayed name is **Hermes Profile Switcher**.

The menu uses technical descriptor names, not custom roster display labels. It is loaded through the SDK query cache with explicit retry, no polling, and fresh route validation on selection. The plugin's own CSS places the control visually before `+` and reduces the inherited gap by half; this is build-dependent and does not reorder keyboard focus.

For host installation and SDK details, see the [official Desktop Plugin SDK documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk). Documentation for a newer host build is not proof of compatibility with an older installed app.
