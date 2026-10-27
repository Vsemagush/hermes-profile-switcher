/**
 * Profile New Chat — an SDK-native new-chat picker for the Hermes Desktop
 * composer, contributed into `COMPOSER_AREAS.leading` (just before the
 * composer's own "+").
 *
 * What it does: the trigger opens an SDK menu of the routes reported by
 * `host.profileRoutes()`. Choosing a row re-reads the route list, verifies that
 * the chosen (connectionId, profile) descriptor is still present and unchanged,
 * and then opens a chat on that profile.
 *
 * Two paths, depending on whether the focused chat's context can be confirmed
 * through public APIs:
 *
 * - no confirmed source context (a fresh draft, no stored id, an unresolved
 *   owner, or a build without the optional doors): `host.newChat(route)` — the
 *   previous honest behaviour, exactly one state-changing call;
 * - confirmed source context on the focused chat's own profile: the folder and
 *   project identity are re-derived from `host.listPersistedSessions` +
 *   `projects.tree` on both routes, and only then is ONE `session.create`
 *   issued on the target route, materialised with `session.title`, confirmed by
 *   a durable read-back and opened with `host.openSession`;
 * - confirmed source context on a DIFFERENT profile: a three-way dialog
 *   (`Copy context` / `Brief handoff` / `Start fresh` / `Cancel`) is shown
 *   first, and the chosen variant seeds the same confirmed create. `Copy
 *   context` reads the focused chat's own transcript (`session.history`) for
 *   its last visible turns; `Brief handoff` assembles one extractive row
 *   locally; `Start fresh` seeds nothing. Cancel/Escape creates nothing.
 *   Every unconfirmed topology is still a visible refusal before any write —
 *   never a shared-path guess, never a created or duplicated project, never a
 *   redirect of the source session.
 *
 * What it deliberately does NOT do: no message is sent, no draft or attachment
 * is read/written/moved, no source session is resumed or modified, no model is
 * called, no credential is stored, and the global workspace cwd is never used
 * as a project. History is read from the focused chat's own route for the two
 * context variants and for two-door emptiness checks, including Start fresh or
 * choosing the current profile. Only context variants seed it into a new chat. Closing
 * the menu or the dialog is a pure UI action. Limits are documented in
 * docs/SDK_NATIVE_PICKER_USAGE.md.
 *
 * Every importable member is read through a namespace object and feature
 * detected before registration: a build missing a required member registers an
 * inert notice instead of failing to link.
 */
import * as sdk from '@hermes/plugin-sdk'
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'

const PLUGIN_ID = 'hermes-profile-switcher'
const LABEL = 'New chat with a profile'
const UNAVAILABLE = 'New chat with a profile is unavailable in this Hermes Desktop build.'
const LOADING_TEXT = 'Loading profiles…'
const LOAD_FAILED_TEXT = 'Could not load the profile list.'
const RETRY_TEXT = 'Retry'
const EMPTY_TEXT = 'No profiles are available for a new chat.'
const MALFORMED_TEXT = 'Some profile routes were invalid and are not shown.'
const AMBIGUOUS_TEXT = 'Some profile routes are ambiguous and are not shown.'
const ROUTE_MISSING_TEXT = 'That profile route is no longer available. No chat was opened.'
const ROUTE_CHANGED_TEXT = 'That profile route changed since the menu opened. Reopen the menu and try again.'
const ROUTE_AMBIGUOUS_TEXT = 'That profile route is ambiguous. No chat was opened.'
const VERIFY_FAILED_TEXT = 'Could not verify the profile route, so no chat was opened.'
const OPEN_FAILED_TEXT = 'Could not open a new chat with that profile.'
const DEFAULT_LABEL = 'Default'
const TRIGGER_ICON = 'account'
const DEFAULT_ICON = 'home'
const ROUTE_QUERY_KEY = [PLUGIN_ID, 'profile-routes']
/** UI heuristic: retain half the native gap; do not resize either control. */
const COMPOSER_GAP_RATIO = 0.5

/** Bounded provenance lookup window; the SDK clamps anything larger to 500. */
const LOOKUP_LIMIT = 200
/** Minting a session can outlast the pool's default deadline. */
const SESSION_RPC_TIMEOUT_MS = 60000
/** Total open attempts: the create is never repeated, only the open is. */
const OPEN_ATTEMPTS = 2
/** Stable prefix of the per-operation create key. */
const IDEMPOTENCY_PREFIX = `${PLUGIN_ID}#handoff`
/** Browser Web Crypto, including non-secure contexts; no counter/time fallback. */
function createKey() {
  try {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)

    return `${IDEMPOTENCY_PREFIX}-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return null
  }
}
const HANDOFF_TITLE = 'New chat with'
const INHERIT_FAILED_TEXT = 'Could not open a new chat with that profile.'
/** Last visible turns a copy carries over; a UI heuristic, not a gateway limit. */
const TAIL_MESSAGE_LIMIT = 20
/** Total characters of copied text; a UI heuristic that bounds the seed payload. */
const TAIL_CHAR_BUDGET = 12000
/** How many of the copied turns the extractive brief quotes. */
const BRIEF_EXCERPT_LIMIT = 6
/** Per-excerpt character cap; a UI heuristic. */
const BRIEF_EXCERPT_CHARS = 240
const BRIEF_HEADER = 'Handoff brief (extractive; assembled locally from the copied chat, no model was called).'
/** The three-way dialog. English copy is the plugin's own UI string, not native text. */
const DIALOG_DESCRIPTION = 'The new chat opens on that profile. Choose what to carry over from this chat.'
const CANCEL_ACTION = 'Cancel'
const COPY_ACTION = 'Copy context'
const BRIEF_ACTION = 'Brief handoff'
const FRESH_ACTION = 'Start fresh'
const COPY_EMPTY_TEXT = 'That chat has no visible messages to copy, so the new chat opened without copied context.'
/** A live, empty, not-yet-persisted draft: nothing exists to carry over. */
const EMPTY_DRAFT_TEXT = 'That chat is empty, so the new chat opened without carried context.'
/** Seeded scaffolding note; never starts with "[System:" (the gateway hides those user rows). */
const provenanceFor = profile =>
  `Context copied from the "${profile}" profile by the profile switcher. ` +
  `The messages below were written in that profile's chat, so those replies belong to the "${profile}" profile and not to this chat's profile.`
const capNote = (dropped, clipped) => {
  const parts = []

  if (dropped > 0) {
    parts.push(`${dropped} earlier message(s) omitted`)
  }

  if (clipped) {
    parts.push('the most recent message shortened')
  }

  return `Copy cap (last ${TAIL_MESSAGE_LIMIT} messages, ${TAIL_CHAR_BUDGET} characters): ${parts.join('; ')}.`
}

/**
 * Visible refusals. Every one is an explicit, compact English message issued
 * through the existing `notify` door with the current error severity; none of
 * them creates, opens or redirects anything.
 */
const REFUSALS = {
  'crypto-unavailable': 'Secure random keys are unavailable in this Desktop runtime. No chat was created.',
  'route-missing': ROUTE_MISSING_TEXT,
  'route-changed': ROUTE_CHANGED_TEXT,
  'route-ambiguous': ROUTE_AMBIGUOUS_TEXT,
  'route-unreadable': VERIFY_FAILED_TEXT,
  'source-owner': 'The focused chat source could not be identified. No chat was opened.',
  'source-session': 'The focused chat has no stored session to inherit from. No chat was opened.',
  'source-missing': 'The focused chat belongs to a source that is no longer available. No chat was opened.',
  'source-ambiguous': 'The focused chat source is ambiguous. No chat was opened.',
  'cross-source': 'That profile is on a different source, so the new chat opens without the inherited project.',
  'source-unreadable': 'The focused chat session list could not be read. No chat was opened.',
  'source-projects-unreadable': 'The focused chat project list could not be read. No chat was opened.',
  'lookup-limited': 'The focused chat was not found in the recent session window. No chat was opened.',
  'history-unreadable': 'The focused chat history could not be read, so no chat was opened.',
  'row-missing': 'The focused chat has no stored session row, so no project could be inherited. No chat was opened.',
  'cwd-blank': 'The focused chat has no recorded folder. No chat was opened.',
  mapping: 'The focused chat profile mapping was not confirmed. No chat was opened.',
  'project-missing': 'The focused chat folder is not a project on its source. No chat was opened.',
  'project-ambiguous': 'The focused chat folder matches more than one project. No chat was opened.',
  'project-multi-folder': 'The focused chat project has more than one folder. No chat was opened.',
  'project-lane': 'The focused chat project structure could not be confirmed. No chat was opened.',
  'target-unreadable': 'That profile project list could not be read. No chat was opened.',
  'target-missing': 'That profile has no project for this folder. No chat was opened.',
  'target-conflict': 'That profile has a different project for this folder. No chat was opened.',
  'target-ambiguous': 'That profile has more than one project for this folder. No chat was opened.',
  'target-lane': 'That profile project structure could not be confirmed. No chat was opened.',
  'source-drift': 'The focused chat changed while that profile was being verified. No chat was opened.',
  'create-unclear': 'Could not confirm whether the new chat was created, so nothing was retried. Check that profile before trying again.',
  'create-unconfirmed': 'The new chat could not be confirmed on that profile, so nothing was retried.',
  'open-failed': 'The new chat was created on that profile but could not be opened.',
  abandoned: 'The focused chat changed before the new chat could be opened.'
}

/** Present means non-null; the host decides what a member actually is. */
const isPresent = value => value !== null && value !== undefined

const SDK_MEMBERS = [
  'DropdownMenu',
  'DropdownMenuTrigger',
  'DropdownMenuContent',
  'DropdownMenuItem',
  'Dialog',
  'DialogContent',
  'DialogDescription',
  'DialogFooter',
  'DialogHeader',
  'DialogTitle',
  'Button',
  'Codicon',
  'Tip',
  'useQuery'
]
const REACT_HOOKS = ['useState', 'useRef', 'useEffect']
const RUNTIME_MEMBERS = ['jsx', 'jsxs']

/** A route descriptor is usable only when it carries its full routing identity. */
function isWellFormedRoute(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false
  }

  const { connectionId, profile, targetProfile, mode } = candidate

  if (typeof connectionId !== 'string' || !connectionId.trim()) {
    return false
  }

  if (typeof profile !== 'string' || !profile.trim()) {
    return false
  }

  if (typeof targetProfile !== 'string' || !targetProfile.trim()) {
    return false
  }

  return mode === 'local' || mode === 'remote'
}

/** Routing identity: never the display name. */
const routeKey = route => `${route.connectionId}\u0000${route.profile}`

/** Same source, same profile, same backend profile, same mode — nothing else. */
function isSameRoute(left, right) {
  return (
    left.connectionId === right.connectionId &&
    left.profile === right.profile &&
    left.targetProfile === right.targetProfile &&
    left.mode === right.mode
  )
}

function profileBadgeColors(profile) {
  if (typeof sdk.profileColor === 'function' && typeof sdk.profileColorSoft === 'function') {
    // Native hue is name-only; connection-qualified routing remains independent.
    const color = sdk.profileColor(profile)

    return { backgroundColor: sdk.profileColorSoft(color, 22), color }
  }

  return {
    backgroundColor: 'color-mix(in srgb, var(--ui-text-quaternary) 22%, transparent)',
    color: 'var(--ui-text-quaternary)'
  }
}

/**
 * Turn the route list into menu rows. Malformed entries and duplicate
 * identities are excluded and reported, never silently remapped.
 */
function buildRows(routes) {
  const list = Array.isArray(routes) ? routes : []
  const groups = new Map()
  const problems = []
  let malformed = 0

  for (const candidate of list) {
    if (!isWellFormedRoute(candidate)) {
      malformed += 1

      continue
    }

    const key = routeKey(candidate)
    const group = groups.get(key)

    if (group) {
      group.push(candidate)
    } else {
      groups.set(key, [candidate])
    }
  }

  const entries = []
  let duplicates = 0

  for (const group of groups.values()) {
    if (group.length > 1) {
      duplicates += 1

      continue
    }

    entries.push({ route: { ...group[0] } })
  }

  if (malformed > 0) {
    problems.push(`${MALFORMED_TEXT} (${malformed})`)
  }

  if (duplicates > 0) {
    problems.push(`${AMBIGUOUS_TEXT} (${duplicates})`)
  }

  const nameCounts = new Map()

  for (const entry of entries) {
    nameCounts.set(entry.route.profile, (nameCounts.get(entry.route.profile) ?? 0) + 1)
  }

  for (const entry of entries) {
    const { connectionId, profile, targetProfile } = entry.route
    const details = []

    if ((nameCounts.get(profile) ?? 0) > 1) {
      details.push(connectionId)
    }

    if (targetProfile !== profile) {
      details.push(targetProfile)
    }

    entry.label = profile === 'default' ? DEFAULT_LABEL : profile
    entry.detail = details.join(' · ')
  }

  return { entries, problems, empty: list.length === 0 || entries.length === 0 }
}

/**
 * Canonical folder key for comparing two native paths: separator- and
 * trailing-separator-agnostic, and case-insensitive for drive-letter paths the
 * same way the native tree compares Windows folders. Never used as a project
 * identity on its own — a key match is only a candidate for confirmation.
 */
function folderKey(value) {
  if (typeof value !== 'string') {
    return ''
  }

  const key = value.trim().replace(/[\\]+/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')

  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key
}

/** True when `folder` is `root` itself or nested inside it. */
function isUnder(folder, root) {
  return Boolean(root) && (folder === root || folder.startsWith(`${root}/`))
}

/** A confirmed source owner carries its full routing identity, both non-blank. */
function isWellFormedOwner(candidate) {
  return Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate) &&
    typeof candidate.connectionId === 'string' && candidate.connectionId.trim() !== '' &&
    typeof candidate.profile === 'string' && candidate.profile.trim() !== ''
}

/** A stored session id is a non-blank string, or there is no context at all. */
function isStoredId(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Synchronous snapshot of the three readonly focused-chat atoms. A missing or
 * unreadable atom yields undefined; nothing here falls back to the active
 * gateway profile or to the global workspace cwd.
 */
function sourceSnapshot(host) {
  const state = host?.state
  const read = name => {
    const atom = state?.[name]

    return atom && typeof atom.get === 'function' ? atom.get() : undefined
  }

  return {
    runtimeId: read('focusedSessionId'),
    storedId: read('focusedStoredSessionId'),
    owner: read('focusedSessionOwner')
  }
}

/** The source identity must be unchanged after revalidation, or nothing is written. */
function isSameSnapshot(left, right) {
  if (!left || !right) {
    return false
  }

  if (left.runtimeId !== right.runtimeId || left.storedId !== right.storedId) {
    return false
  }

  const { owner: a } = left
  const { owner: b } = right

  if (a === b) {
    return true
  }

  return Boolean(a && b && !Array.isArray(a) && !Array.isArray(b) &&
    a.connectionId === b.connectionId && a.profile === b.profile)
}

const profileLabel = profile => (profile === 'default' ? DEFAULT_LABEL : profile)

/**
 * Fresh full route identity from the readonly roster door, or a typed refusal.
 * Used after the last awaited read and immediately before every open attempt so
 * an open never dials a descriptor whose snapshot is already stale. A caller
 * without the door (direct contract use) keeps the previous behaviour; a real
 * registration only proceeds when `host.profileRoutes` exists.
 */
async function confirmRoute(host, route, source = null) {
  if (typeof host?.profileRoutes !== 'function') {
    return { ok: true, route }
  }

  let routes

  try {
    routes = await host.profileRoutes()
  } catch {
    return { code: 'route-unreadable', ok: false }
  }

  let confirmed
  // Empty-live proof depends on BOTH mappings. Validate them against the same
  // refreshed roster, with no await between validation and the caller's open.
  for (const expected of source ? [route, source] : [route]) {
    const matches = (Array.isArray(routes) ? routes : []).filter(candidate =>
      isWellFormedRoute(candidate) && routeKey(candidate) === routeKey(expected))

    if (matches.length === 0) return { code: 'route-missing', ok: false }
    if (matches.length > 1) return { code: 'route-ambiguous', ok: false }
    if (!isSameRoute(matches[0], expected)) return { code: 'route-changed', ok: false }
    if (expected === route) confirmed = matches[0]
  }

  return { ok: true, route: { ...confirmed } }
}

/** Latch focus drift, including away-and-back changes during a pending RPC. */
function watchSource(host, snapshot, onDrift = () => {}) {
  let drifted = false
  const check = () => {
    if (!drifted && !isSameSnapshot(snapshot, sourceSnapshot(host))) {
      drifted = true
      onDrift()
    }

    return !drifted
  }
  const stops = snapshot
    ? ['focusedSessionId', 'focusedStoredSessionId', 'focusedSessionOwner']
      .map(name => host.state[name].subscribe(check))
    : []

  return { check: snapshot ? check : () => true, stop: () => stops.forEach(stop => stop()) }
}

/** The explicit title of the new chat; never a copy of the source session's title. */
const newChatTitle = route => `${HANDOFF_TITLE} ${profileLabel(route.profile)}`

/** Historical branch groups share one checkout; only a target may have no rows yet. */
function isTrunkLane(lane, lanePath, allowEmpty = false) {
  if (!Array.isArray(lane?.groups) || !Number.isSafeInteger(lane.sessionCount) || lane.sessionCount < 0) {
    return false
  }

  const { groups } = lane

  if (groups.length === 0) {
    return allowEmpty && lane.sessionCount === 0
  }

  return groups.every(group => group && typeof group === 'object' && !Array.isArray(group) &&
    group.isMain === true && group.isKanban === false && folderKey(group.path) === lanePath)
}

function matchesFolder(node, cwdKey) {
  if (!node) {
    return false
  }

  if (folderKey(node.path) === cwdKey) {
    return true
  }

  return (Array.isArray(node.repos) ? node.repos : []).some(lane => folderKey(lane?.path) === cwdKey)
}

/** `projects.tree` on one route: readonly, profile-scoped, or nothing. */
async function projectTree(host, route) {
  try {
    // `profile` scopes the read to the route's own backend profile; without it a
    // shared app-global gateway would answer for its launch profile instead.
    const answer = await host.requestProfile(route, 'projects.tree', { preview_limit: 0, profile: route.targetProfile })

    return Array.isArray(answer?.projects) ? answer.projects : null
  } catch {
    return null
  }
}

/** Exact synthetic Home membership, not a missing/unverified project. */
function isConfirmedHome(project, storedId) {
  const ids = project?.sessionIds
  const repos = project?.repos
  const repo = Array.isArray(repos) && repos.length === 1 ? repos[0] : null
  const groups = repo?.groups
  const lane = Array.isArray(groups) && groups.length === 1 ? groups[0] : null

  return project?.id === '__no_project__' && project.path === null &&
    project.isNoProject === true && project.isAuto === false &&
    Array.isArray(ids) && ids.includes(storedId) &&
    ids.every(id => isStoredId(id)) && new Set(ids).size === ids.length &&
    project.sessionCount === ids.length &&
    repo?.id === '__no_project__' && repo.path === null && repo.sessionCount === ids.length &&
    lane?.id === '__no_project__' && lane.path === null &&
    lane.isMain === false && lane.isKanban === false && Array.isArray(lane.sessions)
}

/**
 * Empty needs TWO independent public doors to agree, because one of them cannot
 * tell the two cases apart. The live roster (session.active_list) is blind to a
 * defer-hydrating SAVED chat: `_session_live_status` ignores `resume_hydrating`
 * and the build starts only after hydration, so it reports `idle`, and
 * `_session_live_item` counts `len(session["history"])` — which is `[]` for the
 * whole hydration window. A saved non-empty chat therefore looks exactly like a
 * brand-new draft on that door. The persistent door (`session.history`, the same
 * call `readTail` already uses) reads the durable row, so it answers with the
 * real count for a saved chat and zero for a session that was never persisted.
 * Both must agree on emptiness; a disagreement, an error, a missing door or a
 * non-empty answer refuses. `title`, `resume_message_count` and any guessed or
 * global field are never used as evidence.
 */
async function confirmEmptyDraft({ host, source, snapshot }) {
  const runtimeId = typeof snapshot?.runtimeId === 'string' ? snapshot.runtimeId.trim() : ''
  const storedId = isStoredId(snapshot?.storedId) ? snapshot.storedId.trim() : ''

  if (!runtimeId || !storedId || typeof host?.requestProfile !== 'function') {
    return false
  }

  let answer

  try {
    answer = await host.requestProfile(source, 'session.active_list', {
      current_session_id: runtimeId, profile: source.targetProfile
    })
  } catch {
    return false
  }

  const rows = answer?.sessions

  if (!Array.isArray(rows) || !rows.every(row => row && typeof row === 'object' &&
    !Array.isArray(row) && typeof row.id === 'string' && row.id.trim() !== '')) {
    return false
  }

  const mine = rows.filter(row => row.id === runtimeId)

  if (mine.length !== 1) {
    return false
  }

  const row = mine[0]

  // `current` merely echoes id === current_session_id; it is consistency, not
  // independent evidence. Missing/unknown/starting status is NOT idle.
  if (!(row.current === true && row.session_key === storedId && row.message_count === 0 &&
    row.preview === '' && row.status === 'idle')) {
    return false
  }

  // Second, independent door on the SAME session: the durable row. A saved chat
  // that is still hydrating keeps its real count here even while the live roster
  // reports zero, so this is what actually separates the two cases.
  let history

  try {
    history = await host.requestProfile(source, 'session.history',
      { profile: source.targetProfile, session_id: runtimeId }, SESSION_RPC_TIMEOUT_MS)
  } catch {
    return false
  }

  return history?.count === 0 && Array.isArray(history?.messages) && history.messages.length === 0
}

/**
 * Confirm the focused chat's folder -> project identity on its own source route
 * and the matching project on the target route. Returns the strict resolved
 * context or a typed refusal. Fail-closed by construction: an unidentified
 * source, an unconfirmed profile mapping, a missing/blank/out-of-window row, an
 * absent or ambiguous project, a multi-folder or non-trunk lane, a foreign or
 * conflicting target project, and a cross-source target are all refusals before
 * any write — never a shared-path guess, never a project created in the target.
 */
async function resolveInheritedProject({ host, routes, target, snapshot }) {
  const refusal = code => ({ ok: false, code })
  const { owner } = snapshot ?? {}

  if (!isWellFormedOwner(owner)) {
    return refusal('source-owner')
  }

  const storedId = isStoredId(snapshot?.storedId) ? snapshot.storedId.trim() : ''

  if (!storedId) {
    return refusal('source-session')
  }

  const ownerKey = `${owner.connectionId.trim()}\u0000${owner.profile.trim()}`
  const sources = (Array.isArray(routes) ? routes : []).filter(
    candidate => isWellFormedRoute(candidate) && routeKey(candidate) === ownerKey
  )

  if (sources.length === 0) {
    return refusal('source-missing')
  }

  if (sources.length > 1) {
    return refusal('source-ambiguous')
  }

  const source = { ...sources[0] }

  // A different gateway shares no folder identity, so the project cannot be
  // carried. That is not a dead end: the caller opens the new chat WITHOUT a
  // project and says so. The confirmed source descriptor travels with the
  // outcome so the context variants can still read that chat's own tail.
  if (source.connectionId !== target.connectionId || source.mode !== target.mode) {
    return { code: 'cross-source', ok: false, source: { route: source, storedId } }
  }

  // The persisted read is scoped by the source descriptor's own backend profile;
  // a row stamped with another profile means the mapping is not confirmed.
  const sourceProfile = source.targetProfile
  let page

  try {
    page = await host.listPersistedSessions(source, { limit: LOOKUP_LIMIT, profile: sourceProfile })
  } catch {
    return refusal('source-unreadable')
  }

  const rows = Array.isArray(page?.sessions) ? page.sessions : []

  if (rows.some(row => row && typeof row.profile === 'string' && row.profile.trim() !== '' && row.profile.trim() !== sourceProfile)) {
    return refusal('mapping')
  }

  const row = rows.find(candidate => candidate && typeof candidate === 'object' && candidate.id === storedId)

  if (!row) {
    // The bounded page cannot prove emptiness OR disprove positive live proof.
    // Consult the exact live identity before choosing the appropriate refusal.
    if (await confirmEmptyDraft({ host, source, snapshot })) {
      return { code: 'empty-draft', ok: false, source: { route: source, storedId } }
    }

    return refusal(rows.length >= LOOKUP_LIMIT ? 'lookup-limited' : 'row-missing')
  }

  const cwd = typeof row.cwd === 'string' ? row.cwd.trim() : ''

  const sourceProjects = await projectTree(host, source)

  if (!sourceProjects) {
    return refusal('source-projects-unreadable')
  }

  const cwdKey = folderKey(cwd)
  // `sessionIds` is the tree's own single owner record; the path is only a fallback.
  const claimed = sourceProjects.filter(node => Array.isArray(node?.sessionIds) && node.sessionIds.includes(storedId))
  const candidates = claimed.length > 0
    ? claimed
    : sourceProjects.filter(node => folderKey(node?.path) === cwdKey)

  if (candidates.length === 0) {
    return refusal(cwd ? 'project-missing' : 'cwd-blank')
  }

  if (candidates.length > 1) {
    return refusal('project-ambiguous')
  }

  const project = candidates[0]

  if (project.isNoProject === true) {
    // Only authoritative Home membership can discard a persisted launch/home
    // cwd. Never infer No project from a blank row or a path-only match.
    if (!isConfirmedHome(project, storedId) || claimed.length !== 1 ||
      !(row.cwd === null || typeof row.cwd === 'string')) {
      return refusal('project-missing')
    }

    // Home needs no target tree match, but both mappings must still be current
    // after the awaited persisted/tree reads and before any create.
    for (const route of [source, target]) {
      const fresh = await confirmRoute(host, route)
      if (!fresh.ok) return refusal(fresh.code)
    }

    return {
      ok: true,
      source: {
        cwd: '', projectId: null, projectKind: 'none', route: source, storedId,
        title: typeof row.title === 'string' ? row.title.trim() : ''
      },
      target: { cwd: '', noProject: true, projectId: null, projectKind: 'none', route: { ...target } },
      seed: { messages: [] }
    }
  }

  if (!cwd) return refusal('cwd-blank')

  if (!folderKey(project.path)) {
    return refusal('project-missing')
  }

  // An automatic group is an acceptable source context: its folder and lane are
  // inherited exactly like a named project's. Only the multi-folder, worktree,
  // ambiguous and foreign-target cases stay refusals.
  const sourceNamed = project.isAuto !== true
  const lanes = Array.isArray(project.repos) ? project.repos : []

  if (lanes.length !== 1) {
    return refusal('project-multi-folder')
  }

  const lanePath = folderKey(lanes[0]?.path)

  if (!lanePath || lanePath !== folderKey(project.path) || !isUnder(cwdKey, lanePath) ||
    !isTrunkLane(lanes[0], lanePath) || lanes[0].sessionCount === 0 ||
    !Array.isArray(project.sessionIds) || !project.sessionIds.includes(storedId)) {
    return refusal('project-lane')
  }

  const targetProjects = await projectTree(host, target)

  if (!targetProjects) {
    return refusal('target-unreadable')
  }

  const matches = targetProjects.filter(node => matchesFolder(node, cwdKey))

  if (matches.length === 0) {
    return refusal('target-missing')
  }

  if (matches.length > 1) {
    return refusal('target-ambiguous')
  }

  const targetProject = matches[0]

  if (targetProject.isNoProject === true) {
    return refusal('target-missing')
  }

  // A named target project is the same project only when it carries the same id.
  // An automatic group for the identical folder is the native merge case, and an
  // automatic SOURCE has no named identity for a named target to collide with —
  // the folder plus its single trunk lane already confirm the context.
  if (targetProject.isAuto !== true && sourceNamed && targetProject.id !== project.id) {
    return refusal('target-conflict')
  }

  const targetLanes = Array.isArray(targetProject.repos) ? targetProject.repos : []

  if (targetLanes.length !== 1) {
    return refusal('target-lane')
  }

  const targetLanePath = folderKey(targetLanes[0]?.path)
  // Discovery's project-level count may be cached/nonzero with no loaded rows.
  // Only repo count + explicit empty membership can confirm an empty target.
  const targetHasNoRows = Array.isArray(targetProject.sessionIds) && targetProject.sessionIds.length === 0

  if (!targetLanePath || targetLanePath !== folderKey(targetProject.path) ||
    !isUnder(cwdKey, targetLanePath) || !isTrunkLane(targetLanes[0], targetLanePath, targetHasNoRows)) {
    return refusal('target-lane')
  }

  return {
    ok: true,
    source: {
      cwd,
      projectId: project.id,
      // Named vs automatic is display/attribution only: both are inherited.
      projectKind: sourceNamed ? 'named' : 'auto',
      route: source,
      storedId,
      // Display title only when the row carries one; the brief falls back to the
      // first copied user turn. Never used as a session identity.
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : ''
    },
    target: {
      cwd,
      projectId: targetProject.id,
      projectKind: targetProject.isAuto === true ? 'auto' : 'named',
      route: { ...target }
    },
    // Stage 1 inherits the project only; a later stage fills this seed.
    seed: { messages: [] }
  }
}

/** Recognised native media markers rendered by `_history_dict_text`. */
const MEDIA_PLACEHOLDER = /\[(?:image|audio|screenshot|structured content|input_image|input_audio)\]/g
/**
 * A data-URI header plus its base64 payload. `=` is deliberately outside the
 * payload class so greedy matching stops at the padding instead of running into
 * the prose the native projection concatenates directly after the media part.
 */
const MEDIA_DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,([a-z0-9+/]*)(={0,2})/gi

/**
 * Remove recognisable attachment tokens only. Native `_coerce_message_text`
 * puts a "\n" before a media part and then concatenates the next text part with
 * NO separator, so a payload can be glued to the caption that follows it.
 *
 * Base64 padding is an exact end-of-payload signal; end of line is only a
 * heuristic, and it can fail: when an unpadded payload is glued to a caption
 * that is itself pure base64 characters (`A-Z a-z 0-9 + /`), caption and
 * payload are indistinguishable and that caption is removed too. Any other
 * glued value is left verbatim, so the payload itself then travels into
 * Copy/Brief as ordinary text. The flatten projection has already dropped the
 * media type, so no further boundary can be recovered without guessing, and
 * guessing was deliberately not taken.
 */
function withoutAttachments(text) {
  return text
    .replace(/@image:(?:`[^`\r\n]+`|"[^"\r\n]+"|'[^'\r\n]+'|[^\s`"']+)/g, '')
    .replace(MEDIA_DATA_URI, (whole, _payload, padding, offset, source) => {
      // Padding is exact; the line-end test is the heuristic described above.
      return padding || /^[ \t]*(?:\r?\n|$)/.test(source.slice(offset + whole.length)) ? '' : whole
    })
    .replace(/\[Image attached at: [^\]\r\n]+\]/g, '')
    .replace(MEDIA_PLACEHOLDER, '')
    .trim()
}

/** Prefer typed content when supplied; projected text has already lost media types. */
function historyRowText(row) {
  const { content } = row ?? {}
  const textPart = part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object' ||
      ![undefined, 'text', 'input_text', 'output_text'].includes(part.type)) return ''

    return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
  }

  if (Array.isArray(content)) {
    return withoutAttachments(content.map(textPart).filter(Boolean).join(' '))
  }

  if (content && typeof content === 'object') {
    return withoutAttachments(textPart(content))
  }

  return withoutAttachments(typeof row?.text === 'string' && row.text.trim() !== ''
    ? row.text : typeof content === 'string' ? content : '')
}

/**
 * The copyable words of a projected transcript, oldest first: real `user` and
 * `assistant` turns only. `display_kind: 'hidden'` scaffolding, tool rows (by
 * role or by any tool metadata), system rows, gateway notices (role=user rows
 * beginning with `[System:`), blank rows and attachment-only rows are dropped.
 */
function visibleHistoryRows(answer) {
  const rows = Array.isArray(answer?.messages) ? answer.messages : []
  const visible = []

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue
    }

    const { role } = row

    if (role !== 'user' && role !== 'assistant') {
      continue
    }

    if (row.display_kind === 'hidden') {
      continue
    }

    if (isPresent(row.tool_call_id) || isPresent(row.args) || isPresent(row.labels) ||
      isPresent(row.name) || isPresent(row.context)) {
      continue
    }

    const text = historyRowText(row)

    if (!text || (role === 'user' && text.startsWith('[System:'))) {
      continue
    }

    visible.push({ role, text })
  }

  return visible
}

/**
 * Read the tail of the focused chat's own transcript through the public
 * per-route door: the last `TAIL_MESSAGE_LIMIT` visible turns, never exceeding
 * `TAIL_CHAR_BUDGET` characters. Truncation is stated in the provenance note,
 * never silent. The history content itself is never logged. Read-only: the
 * source session is not resumed, redirected or written.
 */
async function readTail(host, sourceRoute, runtimeId) {
  const route = { ...sourceRoute }
  const sessionId = isStoredId(runtimeId) ? runtimeId.trim() : ''

  if (!sessionId) {
    return { code: 'history-unreadable', ok: false }
  }

  let answer

  try {
    // `profile` scopes the read to the source route's own backend profile.
    answer = await host.requestProfile(
      route,
      'session.history',
      { profile: route.targetProfile, session_id: sessionId },
      SESSION_RPC_TIMEOUT_MS
    )
  } catch {
    return { code: 'history-unreadable', ok: false }
  }

  const rows = visibleHistoryRows(answer)
  const recent = rows.slice(-TAIL_MESSAGE_LIMIT)
  const kept = []
  let dropped = rows.length - recent.length
  let remaining = TAIL_CHAR_BUDGET
  let clipped = false

  // Newest first: keep whole turns while they fit, and only ever shorten the
  // newest turn (when even it alone exceeds the budget).
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const row = recent[index]

    if (row.text.length <= remaining) {
      kept.push(row)
      remaining -= row.text.length + 1

      continue
    }

    if (kept.length === 0) {
      kept.push({ role: row.role, text: row.text.slice(0, TAIL_CHAR_BUDGET) })
      clipped = true
      dropped += index
    } else {
      dropped += index + 1
    }

    break
  }

  kept.reverse()

  const base = provenanceFor(route.targetProfile)
  const provenance = dropped > 0 || clipped ? `${base}\n\n${capNote(dropped, clipped)}` : base

  return { clipped, messages: kept, ok: true, omitted: dropped, profile: route.targetProfile, provenance, route }
}

/** Copy context: the provenance note plus the copied turns, or an empty seed. */
function buildContextSeed(tail) {
  if (tail?.ok !== true || !Array.isArray(tail.messages) || tail.messages.length === 0) {
    return { messages: [] }
  }

  const rows = [{ content: tail.provenance, role: 'system' }]

  for (const message of tail.messages) {
    rows.push({ content: message.text, role: message.role })
  }

  return { messages: rows }
}

const excerpt = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim()

  return flat.length > BRIEF_EXCERPT_CHARS ? `${flat.slice(0, BRIEF_EXCERPT_CHARS)}…` : flat
}

/**
 * Brief handoff: ONE seed row, assembled locally from data already in hand —
 * no model call, no extra RPC and no summary service. `source` is the
 * confirmed source identity (profile, connection, session id, folder and
 * project) and `tail` the already-read transcript.
 */
function buildBrief({ source, tail } = {}) {
  const profile = typeof source?.profile === 'string' && source.profile.trim() !== '' ? source.profile.trim() : 'unknown'
  const origin = []

  if (typeof source?.connectionId === 'string' && source.connectionId.trim() !== '') {
    origin.push(source.connectionId.trim())
  }

  if (isStoredId(source?.storedId)) {
    origin.push(`session ${source.storedId.trim()}`)
  }

  const parts = [
    BRIEF_HEADER,
    `Source: ${profile}${origin.length > 0 ? ` (${origin.join(', ')})` : ''}.`
  ]

  if (typeof source?.cwd === 'string' && source.cwd.trim() !== '') {
    const project = typeof source?.projectId === 'string' && source.projectId.trim() !== ''
      ? ` (${source.projectId.trim()})`
      : ''

    parts.push(`Project: ${source.cwd.trim()}${project}.`)
  }

  const rows = tail?.ok === true && Array.isArray(tail.messages) ? tail.messages : []
  const titled = typeof source?.title === 'string' && source.title.trim() !== '' ? source.title.trim() : ''
  const firstUser = rows.find(message => message.role === 'user')

  parts.push(`Topic: ${excerpt(titled || firstUser?.text || '') || 'not recorded'}.`)

  const excerpts = rows.slice(-BRIEF_EXCERPT_LIMIT)

  if (excerpts.length > 0) {
    parts.push(`Recent messages (last ${excerpts.length}):`)

    for (const message of excerpts) {
      parts.push(`${message.role}: ${excerpt(message.text)}`)
    }
  }

  if (tail?.omitted > 0 || tail?.clipped === true) {
    parts.push(`Excerpt cap: last ${BRIEF_EXCERPT_LIMIT} messages, ${BRIEF_EXCERPT_CHARS} characters each.`)
  }

  return { messages: [{ content: parts.join('\n'), role: 'user' }] }
}

/**
 * The seed for one dialog variant. `fresh` seeds nothing (the create is
 * unseeded and materialised by `session.title`); `copy` seeds the provenance
 * note plus the copied tail; `brief` seeds one locally assembled row. Only the
 * two context variants read the source history, and neither calls a model, a
 * prompt or a summary service.
 */
async function variantSeed({ host, kind, resolved, runtimeId }) {
  if (kind === 'fresh') {
    return { seed: { messages: [] } }
  }

  const tail = await readTail(host, resolved.source.route, runtimeId)

  if (!tail.ok) {
    return { message: REFUSALS[tail.code] ?? REFUSALS['history-unreadable'], refused: true }
  }

  if (kind === 'brief') {
    return {
      seed: buildBrief({
        source: {
          connectionId: resolved.source.route.connectionId,
          cwd: resolved.source.cwd,
          profile: resolved.source.route.targetProfile,
          projectId: resolved.source.projectId,
          storedId: resolved.source.storedId,
          title: resolved.source.title
        },
        tail
      })
    }
  }

  const seed = buildContextSeed(tail)

  return seed.messages.length === 0 ? { notice: COPY_EMPTY_TEXT, seed } : { seed }
}

/**
 * One create -> (materialise) -> durable confirm -> open, on the validated full
 * target route. Exactly ONE `session.create` is ever issued for the operation:
 * an unclear response is a reconciliation refusal, a failed open retries only
 * the open. Hidden is false so the new session is durably reachable, no parent
 * is ever sent, and the source session is not touched. A confirmed project
 * folder is inherited with `cwd_explicit`; a cross-source handoff has no shared
 * folder identity, so that create carries no `cwd` at all rather than a guess.
 */
async function openInheritedChat({ host, context, seed, key, isCurrent }) {
  if (!isCurrent()) {
    return { code: 'abandoned', ok: false }
  }

  if (!key) {
    return { code: 'crypto-unavailable', ok: false }
  }

  const route = { ...context.target.route }
  const { cwd } = context.target
  const project = typeof cwd === 'string' && cwd.trim() !== ''
  const messages = Array.isArray(seed?.messages) ? seed.messages : []
  const title = typeof seed?.title === 'string' && seed.title.trim() !== '' ? seed.title : newChatTitle(route)
  const params = {
    close_on_disconnect: false,
    follow_profile_config: true,
    hidden: false,
    idempotency_key: key,
    profile: route.targetProfile,
    source: 'desktop',
    title
  }

  if (project) {
    params.cwd = cwd
    params.cwd_explicit = true
  }

  if (messages.length > 0) {
    params.messages = messages
  }

  let created

  // The last awaited read before create must confirm BOTH full mappings.
  const fresh = await confirmRoute(host, route, context.source?.route)
  if (!isCurrent()) return { code: 'abandoned', ok: false }
  if (!fresh.ok) return fresh

  try {
    created = await host.requestProfile(route, 'session.create', params, SESSION_RPC_TIMEOUT_MS)
  } catch {
    return { code: 'create-unclear', ok: false }
  }

  const runtimeId = typeof created?.session_id === 'string' ? created.session_id.trim() : ''
  const storedId = typeof created?.stored_session_id === 'string' ? created.stored_session_id.trim() : ''

  if (!runtimeId || !storedId) {
    return { code: 'create-unclear', ok: false }
  }

  const recovery = {
    runtimeId, storedId, route, cwd, noProject: context.target.noProject === true,
    messageCount: messages.length, expectHistory: messages.length > 0
  }
  const failed = code => ({ code, ok: false, recovery })

  if (!isCurrent()) return failed('abandoned')

  // Only our new empty create is materialised; recovery never repeats this write.
  if (messages.length === 0) {
    try {
      await host.requestProfile(route, 'session.title', { session_id: runtimeId, title }, SESSION_RPC_TIMEOUT_MS)
    } catch {
      return failed('create-unconfirmed')
    }

    if (!isCurrent()) return failed('abandoned')
  }

  return openKnownChat({ host, recovery, isCurrent })
}

/** One plain `host.newChat` reached AFTER awaited reads: the route is re-read and
 * the write is skipped if the descriptor moved. Nothing is created or retried. */
async function openPlainChat({ host, isCurrent, route, source }) {
  if (!isCurrent()) {
    return { code: 'abandoned', ok: false }
  }

  const fresh = await confirmRoute(host, route, source)

  if (!isCurrent()) {
    return { code: 'abandoned', ok: false }
  }

  if (!fresh.ok) {
    return { code: fresh.code, ok: false }
  }

  try {
    host.newChat(fresh.route)
  } catch {
    return { code: 'new-chat-failed', ok: false }
  }

  return { ok: true }
}

/** Read-only confirmation and opening of exact known IDs; never re-create/title. */
async function openKnownChat({ host, recovery, isCurrent }) {
  const { runtimeId, storedId, route, cwd, messageCount, expectHistory } = recovery
  const failed = code => ({ code, ok: false, recovery })

  if (!isCurrent()) return failed('abandoned')

  let page
  try {
    page = await host.listPersistedSessions(route, { limit: LOOKUP_LIMIT, profile: route.targetProfile })
  } catch {
    return failed('create-unconfirmed')
  }

  if (!isCurrent()) return failed('abandoned')

  const rows = Array.isArray(page?.sessions) ? page.sessions : []
  const row = rows.find(candidate => candidate && typeof candidate === 'object' && candidate.id === storedId)

  if (!row || row.profile !== route.targetProfile || row.message_count !== messageCount ||
    (recovery.noProject === true && row.cwd !== null) ||
    (cwd && folderKey(row.cwd) !== folderKey(cwd))) {
    return failed('create-unconfirmed')
  }

  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
    // The read-back and any previous attempt are awaited windows: the roster is
    // re-read here so an open never dials a descriptor verified before them.
    const fresh = await confirmRoute(host, route)

    if (!isCurrent()) return failed('abandoned')
    if (!fresh.ok) return failed(fresh.code)

    try {
      await host.openSession(storedId, { awaitHydration: true, expectHistory, route: fresh.route })

      return { ok: true, runtimeId, storedId }
    } catch {
      if (!isCurrent()) return failed('abandoned')
    }
  }

  return failed('open-failed')
}

// Exported for direct contract tests: the resolvers and the write path are
// plain functions with no UI, so they can be exercised without a rendered menu.
export const handoff = {
  BRIEF_EXCERPT_CHARS,
  BRIEF_EXCERPT_LIMIT,
  LOOKUP_LIMIT,
  REFUSALS,
  TAIL_CHAR_BUDGET,
  TAIL_MESSAGE_LIMIT,
  buildBrief,
  buildContextSeed,
  openInheritedChat,
  readTail,
  resolveInheritedProject,
  sourceSnapshot
}

function ProfileNewChatPicker({ context }) {
  const { jsx, jsxs, host, session, components, readout, handoffCapability } = context
  const {
    Button, Codicon, Tip, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
  } = components
  const [open, setOpen] = React.useState(false)
  // The stage-2 choice. It lives on the picker, never inside the menu content:
  // the menu unmounts on selection and the dialog must outlive it.
  const [prompt, setPrompt] = React.useState(null)
  // Mount-local only: reload/unmount discards these recovery handles.
  const [recoveries, setRecoveries] = React.useState([])
  // Capability selection is fixed for this registration, not conditional on
  // focus or roster values. SDK useValue owns the mount-scoped subscriptions.
  const owner = readout ? sdk.useValue(readout.owner) : null
  const storedId = readout ? sdk.useValue(readout.storedId) : undefined
  const knownOwner = typeof storedId === 'string' && storedId.trim() &&
    owner && typeof owner === 'object' && !Array.isArray(owner) &&
    typeof owner.connectionId === 'string' && owner.connectionId.trim() &&
    typeof owner.profile === 'string' && owner.profile.trim()
  const focusedLabel = knownOwner
    ? `${owner.profile === 'default' ? DEFAULT_LABEL : owner.profile} (${owner.connectionId})`
    : readout && (storedId === null || storedId === '')
      ? 'new draft (owner not indicated)'
      : 'unknown'
  const triggerLabel = `Focused chat: ${focusedLabel}. ${LABEL}`
  const triggerBadge = knownOwner && owner.profile !== 'default'
    ? jsx('span', {
        'aria-hidden': true,
        className: 'grid size-4 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-semibold uppercase leading-none',
        style: profileBadgeColors(owner.profile),
        children: Array.from(owner.profile)[0].toUpperCase()
      })
    : jsx(Codicon, {
        'aria-hidden': true,
        name: knownOwner ? DEFAULT_ICON : TRIGGER_ICON,
        size: '0.875rem'
      })

  // Liveness of THIS mount, separate from plugin disposal `session.alive`:
  // an effect re-run (React StrictMode's mount/unmount/mount probe) re-arms it
  // instead of permanently killing the picker, while a genuine unmount stops
  // every in-flight callback of the instance that went away.
  const instance = React.useRef({ alive: true })

  React.useEffect(() => {
    const mount = instance.current

    mount.alive = true

    return () => {
      mount.alive = false
      session.generation += 1
      session.pending = false
      for (const stop of session.stops) stop()
    }
  }, [])

  const query = sdk.useQuery({
    queryKey: ROUTE_QUERY_KEY,
    queryFn: () => host.profileRoutes(),
    retry: false,
    staleTime: 15000
  })

  const notify = message => {
    if (typeof host.notify === 'function') {
      host.notify({ kind: 'error', message })
    }
  }

  const trackSource = (snapshot, generation) => {
    const watcher = watchSource(host, snapshot, () => {
      // Do not hold the UI lock until a stale RPC times out. A new click starts
      // a new generation; the old continuation remains permanently invalid.
      if (generation === session.generation) session.pending = false
    })
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      watcher.stop()
      session.stops.delete(stop)
    }
    session.stops.add(stop)

    return { check: watcher.check, stop }
  }

  const remember = outcome => {
    if (!outcome.ok && outcome.recovery && session.alive && instance.current.alive) {
      setRecoveries(previous => previous.some(item => item.storedId === outcome.recovery.storedId &&
        isSameRoute(item.route, outcome.recovery.route)) ? previous : [...previous, outcome.recovery])
    }
  }

  const recover = async recovery => {
    if (session.pending || !session.alive || !instance.current.alive) return

    session.pending = true
    const generation = (session.generation += 1)
    const source = trackSource(sourceSnapshot(host), generation)
    const isCurrent = () => session.alive && instance.current.alive && generation === session.generation && source.check()

    try {
      let routes
      try {
        routes = await host.profileRoutes()
      } catch {
        if (isCurrent()) notify(VERIFY_FAILED_TEXT)
        return
      }
      if (!isCurrent()) return

      const matches = (Array.isArray(routes) ? routes : []).filter(candidate =>
        isWellFormedRoute(candidate) && routeKey(candidate) === routeKey(recovery.route))
      if (matches.length !== 1 || !isSameRoute(matches[0], recovery.route)) {
        notify(matches.length === 0 ? ROUTE_MISSING_TEXT : matches.length > 1 ? ROUTE_AMBIGUOUS_TEXT : ROUTE_CHANGED_TEXT)
        return
      }

      const outcome = await openKnownChat({ host, recovery, isCurrent })
      if (outcome.ok) {
        if (session.alive && instance.current.alive) setRecoveries(previous => previous.filter(item => item !== recovery))
      } else if (isCurrent()) {
        notify(REFUSALS[outcome.code] ?? INHERIT_FAILED_TEXT)
      }
    } finally {
      source.stop()
      if (generation === session.generation) session.pending = false
    }
  }

  /**
   * The only host operations in this plugin. One refresh, one verification, and
   * then either exactly one newChat or one confirmed create/title/read-back/open
   * handoff. Late results after dispose/reload are dropped.
   */
  const chooseRoute = async descriptor => {
    if (session.pending || !session.alive || !instance.current.alive) {
      return
    }

    session.pending = true

    const generation = (session.generation += 1)
    const isCurrent = () => session.alive && instance.current.alive && generation === session.generation
    // Taken before the first await and re-checked before any write.
    const snapshot = handoffCapability ? sourceSnapshot(host) : null
    const source = trackSource(snapshot, generation)
    const canContinue = () => isCurrent() && source.check()

    try {
      let routes

      try {
        routes = await host.profileRoutes()
      } catch {
        if (isCurrent()) {
          notify(VERIFY_FAILED_TEXT)
        }

        return
      }

      if (!isCurrent()) {
        return
      }

      const key = routeKey(descriptor)
      const matches = (Array.isArray(routes) ? routes : []).filter(
        candidate => isWellFormedRoute(candidate) && routeKey(candidate) === key
      )

      if (matches.length === 0) {
        notify(ROUTE_MISSING_TEXT)

        return
      }

      if (matches.length > 1) {
        notify(ROUTE_AMBIGUOUS_TEXT)

        return
      }

      const fresh = matches[0]

      if (!isSameRoute(descriptor, fresh)) {
        notify(ROUTE_CHANGED_TEXT)

        return
      }

      if (!canContinue()) {
        return
      }

      // No confirmed source context — a fresh draft, an unresolved owner or a
      // build without the optional doors — keeps the previous honest behaviour.
      // No project is invented and the global cwd is never consulted.
      if (!snapshot || !isWellFormedOwner(snapshot.owner) || !isStoredId(snapshot.storedId)) {
        try {
          // The host's own refreshed descriptor, verbatim: every source field is
          // preserved and no name-only shorthand is ever used.
          host.newChat(fresh)
        } catch {
          notify(OPEN_FAILED_TEXT)
        }

        return
      }

      // A different, confirmed profile is a handoff: ask how the context should
      // travel before anything is written. Choosing the focused chat's own
      // profile keeps the stage-1 behaviour and inherits the project directly.
      if (routeKey(fresh) !== routeKey(snapshot.owner)) {
        setPrompt({ route: fresh, snapshot })

        return
      }

      const resolved = await resolveInheritedProject({ host, routes, snapshot, target: fresh })

      if (!isCurrent()) {
        return
      }

      // A live, empty, unpersisted draft has nothing to carry: no project to
      // inherit and no words to copy. It still opens a chat on that profile —
      // the same honest action as the unconfirmed-context path.
      if (!resolved.ok && resolved.code === 'empty-draft') {
        const plain = await openPlainChat({ host, isCurrent: canContinue, route: fresh, source: resolved.source.route })

        if (!isCurrent() || plain.ok || plain.code === 'abandoned') {
          return
        }

        notify(REFUSALS[plain.code] ?? OPEN_FAILED_TEXT)

        return
      }

      if (!resolved.ok) {
        notify(REFUSALS[resolved.code] ?? INHERIT_FAILED_TEXT)

        return
      }

      if (!isSameSnapshot(snapshot, sourceSnapshot(host))) {
        notify(REFUSALS['source-drift'])

        return
      }

      const outcome = await openInheritedChat({
        context: resolved,
        host,
        isCurrent: canContinue,
        key: handoffCapability.key(),
        seed: resolved.seed
      })

      remember(outcome)

      if (!isCurrent() || outcome.ok || outcome.code === 'abandoned') {
        return
      }

      notify(REFUSALS[outcome.code] ?? INHERIT_FAILED_TEXT)
    } finally {
      source.stop()
      if (generation === session.generation) {
        session.pending = false
      }
    }
  }

  /**
   * One dialog variant. The dialog closes as soon as the choice is made and the
   * work continues exactly like the menu path: one refresh, one resolution, one
   * create. Any failure is a visible notice and nothing is retried.
   */
  const commit = async kind => {
    const choice = prompt

    if (!choice || session.pending || !session.alive || !instance.current.alive) {
      return
    }

    setPrompt(null)
    session.pending = true

    const target = { ...choice.route }
    const { snapshot } = choice
    const generation = (session.generation += 1)
    const isCurrent = () => session.alive && instance.current.alive && generation === session.generation
    const key = handoffCapability.key()
    const source = trackSource(snapshot, generation)
    const canContinue = () => isCurrent() && source.check()

    try {
      let routes

      try {
        routes = await host.profileRoutes()
      } catch {
        if (isCurrent()) {
          notify(VERIFY_FAILED_TEXT)
        }

        return
      }

      if (!isCurrent()) {
        return
      }

      const matches = (Array.isArray(routes) ? routes : []).filter(
        candidate => isWellFormedRoute(candidate) && routeKey(candidate) === routeKey(target)
      )

      if (matches.length === 0) {
        notify(ROUTE_MISSING_TEXT)

        return
      }

      if (matches.length > 1) {
        notify(ROUTE_AMBIGUOUS_TEXT)

        return
      }

      const fresh = matches[0]

      if (!isSameRoute(target, fresh)) {
        notify(ROUTE_CHANGED_TEXT)

        return
      }

      if (!isCurrent()) {
        return
      }

      const resolved = await resolveInheritedProject({ host, routes, snapshot, target: fresh })

      if (!isCurrent()) {
        return
      }

      // A different gateway cannot carry the project, but it is not a dead end:
      // the chat still opens, without a project, and the user is told so. A
      // proven empty draft is the same "nothing to carry" case. Every other
      // unconfirmed topology stays a visible refusal before any write.
      const crossSource = !resolved.ok && resolved.code === 'cross-source'
      const emptyDraft = !resolved.ok && resolved.code === 'empty-draft'

      if (!resolved.ok && !crossSource && !emptyDraft) {
        notify(REFUSALS[resolved.code] ?? INHERIT_FAILED_TEXT)

        return
      }

      if (!isSameSnapshot(snapshot, sourceSnapshot(host))) {
        notify(REFUSALS['source-drift'])

        return
      }

      // No fake seed here: the source proved it has no words and no folder, so
      // every variant of "carry something over" is honestly just a new chat.
      if (emptyDraft) {
        const plain = await openPlainChat({ host, isCurrent: canContinue, route: fresh, source: resolved.source.route })

        if (!isCurrent() || plain.code === 'abandoned') {
          return
        }

        if (plain.ok) {
          if (kind !== 'fresh') {
            notify(EMPTY_DRAFT_TEXT)
          }

          return
        }

        notify(REFUSALS[plain.code] ?? OPEN_FAILED_TEXT)

        return
      }

      const variant = await variantSeed({ host, kind, resolved, runtimeId: snapshot.runtimeId })

      if (!canContinue()) {
        return
      }

      if (variant.refused) {
        notify(variant.message)

        return
      }

      if (variant.notice) {
        notify(variant.notice)
      }

      const context = crossSource
        ? { source: resolved.source, target: { cwd: '', projectId: null, route: fresh } }
        : resolved
      const outcome = await openInheritedChat({ context, host, isCurrent: canContinue, key, seed: variant.seed })

      remember(outcome)

      if (!isCurrent() || outcome.code === 'abandoned') {
        return
      }

      if (outcome.ok) {
        if (crossSource) {
          notify(REFUSALS['cross-source'])
        }

        return
      }

      notify(REFUSALS[outcome.code] ?? INHERIT_FAILED_TEXT)
    } finally {
      source.stop()
      if (generation === session.generation) {
        session.pending = false
      }
    }
  }

  const trigger = jsx(Tip, {
    label: triggerLabel,
    children: jsx(DropdownMenuTrigger, {
      asChild: true,
      children: jsx(Button, {
        'aria-label': triggerLabel,
        size: 'icon',
        className: 'size-(--composer-control-size) shrink-0 rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
        type: 'button',
        variant: 'ghost',
        children: triggerBadge
      })
    })
  })

  let content = null

  if (open) {
    let body

    if (query.isPending && !query.data) {
      body = jsx('div', {
        className: 'px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)',
        children: LOADING_TEXT
      })
    } else if (query.error) {
      body = jsxs('div', {
        className: 'flex flex-col gap-2 px-2.5 py-2 text-xs text-(--ui-text-secondary)',
        children: [
          jsx('span', { children: LOAD_FAILED_TEXT }),
          jsx(Button, {
            onClick: () => void query.refetch(),
            size: 'inline',
            type: 'button',
            variant: 'text',
            children: RETRY_TEXT
          })
        ]
      })
    } else {
      const { entries, problems, empty } = buildRows(query.data)
      const rows = []

      for (const problem of problems) {
        rows.push(
          jsx(
            'div',
            {
              className: 'px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)',
              children: problem
            },
            `problem:${problem}`
          )
        )
      }

      for (const entry of entries) {
        const isDefault = entry.route.profile === 'default'

        const badge = isDefault
          ? jsx(
              Codicon,
              {
                'aria-hidden': true,
                className: 'text-(--ui-text-secondary)',
                name: DEFAULT_ICON
              },
              'badge'
            )
          : jsx(
              'span',
              {
                'aria-hidden': true,
                className:
                  'grid size-4 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-semibold uppercase leading-none',
                style: profileBadgeColors(entry.route.profile),
                children: entry.label.slice(0, 1).toUpperCase()
              },
              'badge'
            )

        rows.push(
          jsxs(
            DropdownMenuItem,
            {
              onSelect: () => void chooseRoute(entry.route),
              children: [
                badge,
                jsxs(
                  'span',
                  {
                    className: 'flex min-w-0 flex-col',
                    children: [
                      jsx('span', { className: 'truncate', children: entry.label }),
                      entry.detail
                        ? jsx('span', {
                            className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)',
                            children: entry.detail
                          })
                        : null
                    ]
                  },
                  'label'
                )
              ]
            },
            routeKey(entry.route)
          )
        )
      }

      if (empty) {
        rows.push(
          jsx(
            'div',
            {
              className: 'px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)',
              children: EMPTY_TEXT
            },
            'empty'
          )
        )
      }

      body = jsx('div', { className: 'flex flex-col py-0.5', children: rows })
    }

    content = jsx(DropdownMenuContent, { align: 'start', className: 'min-w-52', children: body })
  }

  const menu = jsx(DropdownMenu, {
    children: [trigger, content],
    onOpenChange: next => {
      if (session.alive) {
        setOpen(Boolean(next))
      }
    },
    open
  }, 'menu')

  // Outside DropdownMenuContent on purpose: the menu unmounts on selection and
  // the dialog has to outlive it. Escape, the backdrop and the X all arrive as
  // the native Radix Dialog `onOpenChange(false)`, and cancel without creating
  // anything.
  const choice = jsx(Dialog, {
    children: jsxs(DialogContent, {
      className: 'max-w-md',
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: `Continue with ${prompt ? profileLabel(prompt.route.profile) : DEFAULT_LABEL}?` }, 'title'),
            jsx(DialogDescription, { children: DIALOG_DESCRIPTION }, 'description')
          ]
        }, 'header'),
        jsxs(DialogFooter, {
          children: [
            jsx(Button, { onClick: () => setPrompt(null), type: 'button', variant: 'ghost', children: CANCEL_ACTION }, 'cancel'),
            jsx(Button, { onClick: () => void commit('fresh'), type: 'button', variant: 'outline', children: FRESH_ACTION }, 'fresh'),
            jsx(Button, { onClick: () => void commit('brief'), type: 'button', variant: 'secondary', children: BRIEF_ACTION }, 'brief'),
            jsx(Button, { onClick: () => void commit('copy'), type: 'button', variant: 'default', children: COPY_ACTION }, 'copy')
          ]
        }, 'actions')
      ]
    }, 'content'),
    onOpenChange: value => {
      if (!value) {
        setPrompt(null)
      }
    },
    open: prompt !== null
  }, 'dialog')

  return jsxs('div', {
    className: 'flex items-center',
    // Visual before-plus hint only: our own root, our own inline style. It is
    // not a placement contract and does not touch core CSS or the DOM.
    style: {
      order: -1,
      marginInlineEnd: `calc(var(--composer-control-gap, 0px) * ${COMPOSER_GAP_RATIO - 1})`
    },
    children: [menu, choice, ...recoveries.map(recovery => jsx(Button, {
      onClick: () => void recover(recovery),
      type: 'button',
      variant: 'text',
      size: 'inline',
      title: 'Open this already created chat without creating another. Recovery is available only until this control is unloaded.',
      children: `Open created chat with ${profileLabel(recovery.route.profile)} (${recovery.route.connectionId}, ${recovery.storedId})`
    }, `${routeKey(recovery.route)}\u0000${recovery.storedId}`))]
  })
}

function missingRequirements(host) {
  const missing = []

  for (const member of SDK_MEMBERS) {
    if (!isPresent(sdk[member])) {
      missing.push(`@hermes/plugin-sdk#${member}`)
    }
  }

  for (const hook of REACT_HOOKS) {
    if (typeof React[hook] !== 'function') {
      missing.push(`react#${hook}`)
    }
  }

  for (const member of RUNTIME_MEMBERS) {
    if (typeof runtime[member] !== 'function') {
      missing.push(`react/jsx-runtime#${member}`)
    }
  }

  if (typeof host?.profileRoutes !== 'function') {
    missing.push('host#profileRoutes')
  }

  if (typeof host?.newChat !== 'function') {
    missing.push('host#newChat')
  }

  if (!isPresent(sdk.COMPOSER_AREAS?.leading)) {
    missing.push('@hermes/plugin-sdk#COMPOSER_AREAS.leading')
  }

  return missing
}

export default {
  id: PLUGIN_ID,
  name: 'Profile New Chat',
  register(ctx) {
    const host = sdk.host ?? {}
    const missing = missingRequirements(host)
    const area = sdk.COMPOSER_AREAS?.leading

    // Inert by construction: nothing outside this branch can call a missing
    // host member, and registration never depends on a member that is absent.
    if (missing.length > 0) {
      if (isPresent(area) && typeof runtime.jsx === 'function') {
        ctx.register({
          area,
          id: 'unavailable',
          render: () =>
            runtime.jsx(
              'span',
              {
                'aria-label': UNAVAILABLE,
                className: 'px-1 text-xs text-(--ui-text-tertiary)',
                title: UNAVAILABLE,
                children: UNAVAILABLE
              },
              null
            )
        })
      }

      return
    }

    const session = { alive: true, generation: 0, pending: false, stops: new Set() }
    // Optional readout: never fall back to gateway profile or legacy projection.
    const state = typeof sdk.useValue === 'function' ? host.state : null
    const ownerAtom = state?.focusedSessionOwner
    const storedIdAtom = state?.focusedStoredSessionId
    const runtimeIdAtom = state?.focusedSessionId
    const readable = atom => typeof atom?.get === 'function' && typeof atom?.subscribe === 'function'
    const readout = readable(ownerAtom) && readable(storedIdAtom)
      ? { owner: ownerAtom, storedId: storedIdAtom }
      : null
    // Optional inheritance capability. A build without the runtime atom or the
    // public doors keeps the verified new-chat path and is never half-wired.
    const handoffCapability = readable(ownerAtom) && readable(storedIdAtom) && readable(runtimeIdAtom) &&
      typeof host.listPersistedSessions === 'function' &&
      typeof host.requestProfile === 'function' &&
      typeof host.openSession === 'function'
      ? { key: createKey }
      : null

    ctx.onDispose(() => {
      session.alive = false
      session.generation += 1
      session.pending = false
      for (const stop of session.stops) stop()
    })

    ctx.register({
      area,
      id: 'new-chat',
      render: () =>
        runtime.jsx(
          ProfileNewChatPicker,
          {
            context: {
              components: {
                Button: sdk.Button,
                Codicon: sdk.Codicon,
                Dialog: sdk.Dialog,
                DialogContent: sdk.DialogContent,
                DialogDescription: sdk.DialogDescription,
                DialogFooter: sdk.DialogFooter,
                DialogHeader: sdk.DialogHeader,
                DialogTitle: sdk.DialogTitle,
                DropdownMenu: sdk.DropdownMenu,
                DropdownMenuContent: sdk.DropdownMenuContent,
                DropdownMenuItem: sdk.DropdownMenuItem,
                DropdownMenuTrigger: sdk.DropdownMenuTrigger,
                Tip: sdk.Tip
              },
              host,
              readout,
              handoffCapability,
              jsx: runtime.jsx,
              jsxs: runtime.jsxs,
              session
            }
          },
          null
        )
    })
  }
}
