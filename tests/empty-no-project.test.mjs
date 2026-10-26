// Actual entry with SDK doubles; not a Windows/Electron or live gateway test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, route, focusState, deferred } from './harness.mjs'

const SOURCE = route('local', 'default')
const TARGET = route('local', 'coder')
const OWNER = { connectionId: 'local', profile: 'default' }
const SOURCE_ID = 'stored-home'
const NEW_ID = 'stored-new'

// project_tree._home_project(..., hydrate=False, previews=[]), exact wire shape.
const home = (ids = [SOURCE_ID]) => ({
  id: '__no_project__', label: 'Home', path: null, color: null, icon: null,
  isAuto: false, isNoProject: true, sessionCount: ids.length, lastActive: 0,
  totalTokens: 0, totalCostUsd: 0,
  repos: [{ id: '__no_project__', label: 'Home', path: null, sessionCount: ids.length,
    groups: [{ id: '__no_project__', label: 'Home', path: null,
      isMain: false, isKanban: false, sessions: [] }] }],
  previewSessions: [], sessionIds: ids
})

async function setup({ cwd = null, same = false, nodes, ...overrides } = {}) {
  let count = 0
  const sourceRow = { id: SOURCE_ID, profile: 'default', cwd, message_count: 2 }
  const target = same ? SOURCE : TARGET
  const h = await harness({
    routes: [SOURCE, TARGET], focus: focusState(OWNER, SOURCE_ID, 'rt-home'),
    sessions: r => r.profile === 'default'
      ? [sourceRow, ...(same ? [{ id: NEW_ID, profile: 'default', cwd: null, message_count: count }] : [])]
      : [{ id: NEW_ID, profile: 'coder', cwd: null, message_count: count }],
    projects: () => nodes ?? [home()],
    history: () => ({ count: 2, messages: [{ role: 'user', text: 'Keep the fix small.' }, { role: 'assistant', text: 'Use a regression.' }] }),
    create: (_r, params) => {
      count = params.messages?.length ?? 0
      // Native runtime fallback is nonempty; durable desktop cwd is still null.
      return { session_id: 'rt-new', stored_session_id: NEW_ID, message_count: count,
        messages: [], info: { cwd: '/gateway/launch', profile_name: target.targetProfile } }
    },
    title: () => ({ pending: false }), openSession: async () => {},
    ...overrides
  })
  return h
}
const rounds = async h => { for (let i = 0; i < 8; i += 1) await h.settle() }
const plain = value => JSON.parse(JSON.stringify(value))
const messages = h => h.notices.map(notice => String(notice.message))
/** The resolver's own bounded lookup window, mirrored for the full-page case. */
const POPULATION = 200

async function select(h, same = false) {
  await h.open()
  const item = h.items().find(node => h.text(node).includes(same ? 'Default' : 'coder'))
  assert.ok(item, 'target route is offered')
  h.select(item)
  await rounds(h)
}

async function commit(h, action = 'Start fresh') {
  assert.equal(h.dialogOpen(), true)
  h.dialogAction(action).props.onClick()
  await rounds(h)
}

for (const cwd of [null, '', '/gateway/home']) {
  for (const action of ['Start fresh', 'Copy context', 'Brief handoff']) {
    test(`confirmed Home cwd=${JSON.stringify(cwd)}: ${action} opens durable No project`, async () => {
      const h = await setup({ cwd })
      await select(h)
      await commit(h, action)
      assert.equal(h.creates.length, 1, 'confirmed Home must create the target chat')
      const payload = h.creates[0].params
      assert.equal(Object.hasOwn(payload, 'cwd'), false)
      assert.equal(Object.hasOwn(payload, 'cwd_explicit'), false)
      assert.equal(payload.source, 'desktop')
      assert.equal(payload.profile, 'coder')
      assert.equal(h.opens.length, 1, 'durable null-cwd readback must permit opening')
      assert.equal(h.opens[0].storedId, NEW_ID)
      assert.equal(h.opens[0].options.expectHistory, action !== 'Start fresh')
      assert.equal(h.treeCalls.length, 1, 'Home must not require a target project match')
      assert.equal(h.titles.length, action === 'Start fresh' ? 1 : 0)
      assert.equal(h.histories.length, action === 'Start fresh' ? 0 : 1)
      if (action !== 'Start fresh') {
        assert.match(JSON.stringify(payload.messages), /Keep the fix small/)
        assert.doesNotMatch(JSON.stringify(payload.messages), /Project: \/gateway\/home/)
      }
      assert.ok(h.rpcCalls.filter(c => ['session.create', 'session.title'].includes(c.method))
        .every(c => c.route.profile === 'coder'), 'no source writes')
      assert.equal(h.calls.length, 0, 'no unverified plain newChat fallback')
      h.dispose()
    })
  }
}

test('same-profile confirmed Home uses the shared resolver without a dialog', async () => {
  const h = await setup({ same: true })
  await select(h, true)
  assert.equal(h.dialogOpen(), false)
  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 1)
  assert.equal(h.histories.length, 0)
  h.dispose()
})

for (const [label, change] of [
  ['missing membership', node => { node.sessionIds = [] }],
  ['wrong synthetic id', node => { node.id = 'fake-home' }],
  ['project path', node => { node.path = '/fake' }],
  ['repo path', node => { node.repos[0].path = '/fake' }],
  ['main lane', node => { node.repos[0].groups[0].isMain = true }],
  ['kanban lane', node => { node.repos[0].groups[0].isKanban = true }],
  ['lane path', node => { node.repos[0].groups[0].path = '/fake' }],
  ['auto flag', node => { node.isAuto = true }],
  ['mismatched count', node => { node.repos[0].sessionCount = 0 }]
]) {
  test(`Home remains fail-closed: ${label}`, async () => {
    const node = home()
    change(node)
    const h = await setup({ nodes: [node] })
    await select(h)
    await commit(h)
    assert.equal(h.creates.length, 0)
    assert.equal(h.opens.length, 0)
    assert.ok(h.notices.length > 0)
    h.dispose()
  })
}

test('conflicting Home memberships are refused', async () => {
  const h = await setup({ nodes: [home(), home()] })
  await select(h)
  await commit(h)
  assert.equal(h.creates.length, 0)
  h.dispose()
})

for (const drift of ['navigation', 'away-and-back', 'dispose', 'source-remap', 'target-remap']) {
  test(`Home tree await guard: ${drift}`, async () => {
    const gate = deferred()
    const h = await setup({ projects: () => gate.promise })
    await select(h)
    // Start the commit; it stops inside the awaited source tree read.
    h.dialogAction('Start fresh').props.onClick()
    await h.settle()
    if (drift === 'navigation' || drift === 'away-and-back') {
      h.focus.storedId('elsewhere')
      if (drift === 'away-and-back') h.focus.storedId(SOURCE_ID)
    } else if (drift === 'dispose') h.dispose()
    else h.reader(async () => (drift === 'source-remap'
      ? [{ ...SOURCE, targetProfile: 'changed' }, TARGET]
      : [SOURCE, { ...TARGET, targetProfile: 'changed' }]))
    gate.resolve([home()])
    await rounds(h)
    assert.equal(h.creates.length, 0)
    assert.equal(h.opens.length, 0)
    h.dispose()
  })
}

// ── slice 2: a live, empty, not-yet-persisted draft ────────────────────────
// The desktop mints a runtime id AND a durable id to paint a new chat, while
// the row is created lazily on the first prompt. The focused chat is therefore
// "live and empty with no row" — that must be proven positively by the source's
// own live roster, never inferred from the missing row.

const DRAFT_ID = 'stored-draft'
const RUNTIME_ID = 'rt-draft'
const NO_ROW = () => { throw new Error('an empty draft must not create a session') }

/** One row of the backend's own live roster, in the wire shape of `_session_live_item`. */
const liveRow = (extra = {}) => ({
  current: true, id: RUNTIME_ID, last_active: 0, message_count: 0, model: '',
  preview: '', session_key: DRAFT_ID, started_at: 0, status: 'idle', title: '', ...extra
})

const draft = (overrides = {}) => harness({
  routes: [SOURCE, TARGET],
  focus: focusState(OWNER, DRAFT_ID, RUNTIME_ID),
  // No persisted row anywhere: this draft has never seen a prompt.
  sessions: r => (r.profile === 'default' ? [] : [{ id: NEW_ID, profile: 'coder', cwd: null, message_count: 0 }]),
  live: () => [liveRow()],
  // The persistent door a real unmaterialised draft answers with: no row, so
  // zero messages and no error (methods_session.py:1987-1999).
  history: () => ({ count: 0, messages: [] }),
  create: NO_ROW,
  title: () => { throw new Error('an empty draft must not be titled') },
  openSession: async () => {},
  ...overrides
})

const EMPTY_SOURCE_TEXT = /empty/i

test('same-profile: a proven empty draft opens a plain new chat instead of refusing', async () => {
  const h = await draft()
  await select(h, true)
  assert.equal(h.dialogOpen(), false, 'nothing is carried, so no dialog is shown')
  await rounds(h)
  assert.equal(h.calls.length, 1, 'the confirmed empty draft must still open a chat')
  assert.deepEqual(plain(h.calls[0][0]), plain(SOURCE), 'the refreshed own-profile descriptor, verbatim')
  assert.equal(h.creates.length, 0, 'no session is created or seeded for an empty draft')
  assert.equal(h.titles.length, 0)
  assert.equal(h.histories.length, 1, 'one persistent read: the emptiness probe, nothing copied')
  assert.equal(h.treeCalls.length, 0, 'no project evidence is read or invented')
  assert.deepEqual(h.notices, [], 'opening the chat is not an error')
  // Menu query, selection, then BOTH mappings in one roster before open.
  assert.equal(h.reads, 3, 'both mappings are re-validated across the live await boundary')
  assert.equal(plain(h.liveCalls[0].params).current_session_id, RUNTIME_ID,
    'the live roster is asked about the focused runtime session')
  assert.equal(h.liveCalls[0].route.profile, 'default', 'the roster is read on the source route')
  h.dispose()
})

for (const [kind, label] of [['fresh', 'Start fresh'], ['copy', 'Copy context'], ['brief', 'Brief handoff']]) {
  test(`another profile, ${label}: a proven empty draft opens a plain new chat without a fake seed`, async () => {
    const h = await draft()
    await select(h)
    await commit(h, label)
    assert.equal(h.calls.length, 1, 'the chat opens on the selected profile')
    assert.deepEqual(plain(h.calls[0][0]), plain(TARGET))
    assert.equal(h.creates.length, 0, 'nothing is created, seeded or materialised')
    assert.equal(h.titles.length, 0)
    assert.equal(h.histories.length, 1, 'one persistent read: the emptiness probe, never a copied tail')
    assert.equal(h.treeCalls.length, 0)
    if (kind === 'fresh') assert.deepEqual(h.notices, [], 'Start fresh needs no explanation')
    else assert.ok(messages(h).some(message => EMPTY_SOURCE_TEXT.test(message)),
      `the empty source is explained: ${JSON.stringify(messages(h))}`)
    h.dispose()
  })
}

for (const [label, live] of [
  ['no live roster row', () => []],
  ['a different runtime session', () => [liveRow({ id: 'rt-other' })]],
  ['a live row with messages', () => [liveRow({ message_count: 4 })]],
  ['a live row with a preview', () => [liveRow({ preview: 'typed but unsent' })]],
  ['a live row that is busy', () => [liveRow({ status: 'working' })]],
  ['a live row keyed to another stored id', () => [liveRow({ session_key: 'stored-other' })]],
  ['a malformed live row', () => [null]],
  ['an unreadable live roster', () => { throw new Error('roster timed out') }]
]) {
  test(`an unproven draft stays fail-closed: ${label}`, async () => {
    const h = await draft({ live })
    await select(h, true)
    await rounds(h)
    assert.equal(h.calls.length, 0, 'a missing row alone is never proof of an empty chat')
    assert.equal(h.creates.length, 0)
    assert.equal(h.opens.length, 0)
    assert.ok(messages(h).length > 0, `the refusal is visible: ${JSON.stringify(messages(h))}`)
    h.dispose()
  })
}

test('a persisted row wins: live emptiness is never consulted for a saved chat', async () => {
  const CWD2 = '/srv/projects/repos/saved'
  const saved = {
    ...home(), id: 'p-saved', label: 'saved', path: CWD2, isAuto: false, isNoProject: false,
    sessionIds: [SOURCE_ID], sessionCount: 1,
    repos: [{ id: CWD2, label: 'saved', path: CWD2, sessionCount: 1,
      groups: [{ id: CWD2, label: 'main', path: CWD2, isMain: true, isKanban: false }] }]
  }
  const h = await harness({
    routes: [SOURCE, TARGET],
    focus: focusState(OWNER, SOURCE_ID, 'rt-home'),
    sessions: r => (r.profile === 'default'
      ? [{ id: SOURCE_ID, profile: 'default', cwd: CWD2, message_count: 3 }]
      : [{ id: NEW_ID, profile: 'coder', cwd: CWD2, message_count: 0 }]),
    projects: () => [saved],
    // A backend that restarted would report an empty live history for a SAVED chat.
    live: () => [liveRow({ id: 'rt-home', session_key: SOURCE_ID })],
    create: () => ({ session_id: 'rt-new', stored_session_id: NEW_ID, message_count: 0, messages: [], info: {} }),
    title: () => ({ pending: false }),
    history: () => ({ count: 0, messages: [] }),
    openSession: async () => {}
  })
  await select(h, true)
  await rounds(h)
  assert.equal(h.calls.length, 0, 'a saved chat is not a draft: no plain new chat')
  assert.equal(h.liveCalls.length, 0, 'the live roster is only read when the row is missing')
  assert.equal(h.creates.length, 1, 'the saved project is still inherited')
  assert.equal(h.creates[0].params.cwd, CWD2)
  assert.equal(h.creates[0].params.cwd_explicit, true)
  h.dispose()
})

test('a draft without a focused runtime id keeps the fail-closed refusal', async () => {
  const h = await draft({ focus: focusState(OWNER, DRAFT_ID, '') })
  await select(h, true)
  await rounds(h)
  assert.equal(h.calls.length, 0)
  assert.equal(h.liveCalls.length, 0, 'no roster is read without a live identity to match')
  assert.ok(messages(h).length > 0)
  h.dispose()
})

const fullPage = () => Array.from({ length: POPULATION }, (_, index) => ({
  id: `other-${index}`, profile: 'default', cwd: null, message_count: 1
}))
const fullDraft = (overrides = {}) => draft({ sessions: () => fullPage(), ...overrides })

for (const action of ['same-profile', 'Start fresh', 'Copy context', 'Brief handoff']) {
  test(`full window: proven empty draft opens ${action}`, async () => {
    const h = await fullDraft()
    const same = action === 'same-profile'
    await select(h, same)
    if (!same) await commit(h, action)
    assert.equal(h.calls.length, 1, '200 unrelated persisted rows must not block positive live proof')
    assert.deepEqual(plain(h.calls[0][0]), same ? SOURCE : TARGET)
    assert.equal(h.liveCalls.length, 1)
    assert.deepEqual(plain(h.liveCalls[0].route), SOURCE, 'read only on the exact source route')
    assert.deepEqual(plain(h.liveCalls[0].params), {
      current_session_id: RUNTIME_ID, profile: SOURCE.targetProfile
    })
    assert.equal(h.creates.length + h.titles.length + h.opens.length, 0,
      'no seed, source writes, model calls or materialisation')
    assert.equal(h.histories.length, 1, 'exactly one persistent read: the emptiness probe')
    assert.equal(h.treeCalls.length, 0)
    assert.ok(!messages(h).some(message => /recent session window/i.test(message)))
    h.dispose()
  })
}

test('full window: unproven empty draft keeps the lookup refusal', async () => {
  const h = await fullDraft({ live: () => [] })
  await select(h, true)
  assert.equal(h.calls.length, 0)
  assert.equal(h.liveCalls.length, 1, 'absence of a row is not proof; consult live evidence')
  assert.ok(messages(h).some(message => /recent session window/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('full window: foreign profile rows refuse before live proof', async () => {
  const rows = fullPage()
  rows[0].profile = 'foreign'
  const h = await fullDraft({ sessions: () => rows })
  await select(h, true)
  assert.equal(h.calls.length + h.creates.length, 0)
  assert.equal(h.liveCalls.length, 0, 'mapping evidence cannot be overridden by live emptiness')
  assert.ok(messages(h).some(message => /profile mapping/i.test(message)))
  h.dispose()
})

test('full window: a saved nonempty source cannot become a draft', async () => {
  const rows = fullPage()
  rows[0] = { id: DRAFT_ID, profile: 'default', cwd: null, message_count: 4 }
  const h = await fullDraft({ sessions: () => rows, projects: () => [] })
  await select(h, true)
  assert.equal(h.liveCalls.length, 0)
  assert.equal(h.calls.length + h.creates.length, 0, 'unconfirmed saved workspace still refuses')
  h.dispose()
})

const invalidLive = [
  ['starting', () => [liveRow({ status: 'starting' })]],
  ['missing status', () => [liveRow({ status: undefined })]],
  ['unknown status', () => [liveRow({ status: 'unknown' })]],
  ['null preview', () => [liveRow({ preview: null })]],
  ['missing preview', () => [liveRow({ preview: undefined })]],
  ['boolean preview', () => [liveRow({ preview: false })]],
  ['duplicate runtime', () => [liveRow(), liveRow()]],
  ['wrong key', () => [liveRow({ session_key: 'other' })]],
  ['nonzero messages', () => [liveRow({ message_count: 2 })]],
  ['untyped count', () => [liveRow({ message_count: '0' })]],
  ['waiting', () => [liveRow({ status: 'waiting' })]],
  ['working', () => [liveRow({ status: 'working' })]],
  ['malformed sibling', () => [liveRow(), null]],
  ['malformed sessions', () => ({ sessions: {} })],
  ['malformed envelope', () => null],
  ['unreadable', () => { throw Error('live unavailable') }]
]

for (const [name, live] of invalidLive) {
  test(`strict live proof: ${name} is refused`, async () => {
    const h = await draft({ live })
    await select(h, true)
    assert.equal(h.calls.length, 0, 'only well-formed idle evidence may open an empty chat')
    assert.equal(h.creates.length + h.titles.length + h.opens.length, 0)
    assert.ok(messages(h).some(message => /no stored session row/i.test(message)))
    h.dispose()
  })
}

for (const [name, live] of invalidLive) {
  test(`full window negative control: ${name}`, async () => {
    const h = await fullDraft({ live })
    await select(h, true)
    assert.equal(h.liveCalls.length, 1)
    assert.equal(h.calls.length + h.creates.length + h.opens.length, 0)
    assert.ok(messages(h).some(message => /recent session window/i.test(message)))
    h.dispose()
  })
}

for (const same of [true, false]) {
  for (const drift of ['navigation', 'away-and-back', 'dispose', 'source-remap', 'target-remap']) {
    test(`full window deferred live guard: same=${same}, ${drift}`, async () => {
      const gate = deferred()
      const entered = deferred()
      const h = await fullDraft({ live: () => { entered.resolve(); return gate.promise } })
      await select(h, same)
      if (!same) h.dialogAction('Start fresh').props.onClick()
      await entered.promise
      if (drift === 'navigation' || drift === 'away-and-back') {
        h.focus.storedId('elsewhere')
        if (drift === 'away-and-back') h.focus.storedId(DRAFT_ID)
      } else if (drift === 'dispose') h.dispose()
      else h.reader(async () => (drift === 'source-remap' || same)
        ? [{ ...SOURCE, targetProfile: 'remapped' }, TARGET]
        : [SOURCE, { ...TARGET, targetProfile: 'remapped' }])
      gate.resolve([liveRow()])
      await rounds(h)
      assert.equal(h.calls.length + h.creates.length + h.titles.length + h.opens.length, 0)
      if (drift !== 'dispose') h.dispose()
    })
  }
}

for (const same of [true, false]) {
  for (const drift of ['navigation', 'away-and-back', 'dispose', 'source-remap', 'target-remap']) {
    test(`full window final roster guard: same=${same}, ${drift}`, async () => {
      const gate = deferred()
      const entered = deferred()
      let proofRead = false
      const h = await fullDraft({ live: () => { proofRead = true; return [liveRow()] } })
      h.reader(async () => {
        if (!proofRead) return [SOURCE, TARGET]
        entered.resolve()
        return gate.promise
      })
      await select(h, same)
      if (!same) h.dialogAction('Start fresh').props.onClick()
      await entered.promise
      if (drift === 'navigation' || drift === 'away-and-back') {
        h.focus.runtime('rt-other')
        if (drift === 'away-and-back') h.focus.runtime(RUNTIME_ID)
      } else if (drift === 'dispose') h.dispose()
      const remapSource = drift === 'source-remap' || (same && drift === 'target-remap')
      const remapTarget = !same && drift === 'target-remap'
      gate.resolve([
        remapSource ? { ...SOURCE, targetProfile: 'changed' } : SOURCE,
        remapTarget ? { ...TARGET, targetProfile: 'changed' } : TARGET
      ])
      await rounds(h)
      assert.equal(h.liveCalls.length, 1)
      assert.equal(h.calls.length + h.creates.length + h.opens.length, 0)
      if (drift !== 'dispose') h.dispose()
    })
  }
}

test('opening the icon menu alone does not resolve a full-window source or notify', async () => {
  const h = await fullDraft()
  await h.open()
  await rounds(h)
  assert.equal(h.contributions.length, 1)
  assert.equal(h.contributions[0].area, 'composer.leading', 'no keyboard contribution is registered')
  assert.equal(h.persisted.length + h.liveCalls.length + h.rpcCalls.length, 0)
  assert.equal(h.calls.length + h.opens.length, 0)
  assert.deepEqual(h.notices, [])
  h.dispose()
})

// ── slice 3: a defer-hydrating SAVED chat must never read as empty ─────────
//
// Exact derivation from pin 8b66a51036c1e20920a17cdd049fdf55c968d683 — no
// invented fields:
//   methods_session.py:932–950 `_resume_deferred`: the live record is built with
//     `history=[]`, `resume_hydrating=True`, `resume_message_count=<stored row>`
//     (`ctx.record(source, cwd, [], …)` at :937, `record.update(...)` at :939–940).
//   server.py:3027–3034 `_session_live_status`: reads only pending kind,
//     `agent_ready` + `agent_build_started` and `running` — `resume_hydrating`
//     is NOT consulted, and the build starts only after hydration
//     (server.py:2998), so a hydrating chat reports `idle`.
//   server.py:3044–3065 `_session_live_item`: `message_count = len(session["history"])`
//     and `preview` is taken from that same history — both empty while hydrating.
//   ⇒ during hydration a saved non-empty chat puts EXACTLY the same fields on the
//     wire as a brand-new empty draft.
//   methods_session.py:1980–1999 `session.history`: reads the durable row through
//     `_submit_row_target_key` (session_workdir.py:571–593 → `session_key` while
//     no agent exists) + `get_messages_as_conversation`, so a saved chat answers
//     with its real count while an unmaterialised draft answers zero.

const RESUME_ID = 'stored-saved-201'
const RESUME_RUNTIME = 'rt-resume'
const RESUME_MESSAGES = 4

/** server.py `_session_live_item(sid, session, current)` over a deferred resume. */
const nativeLiveRow = (session, currentSid) => {
  const history = session.history ?? []
  const status = session.agent_build_started && !session.agent_ready ? 'starting'
    : session.running ? 'working' : 'idle'

  return {
    current: session.sid === currentSid,
    id: session.sid,
    last_active: 1,
    message_count: history.length,
    model: '',
    preview: '',
    session_key: session.session_key,
    started_at: 1,
    status,
    title: ''
  }
}

/** The deferred-resume record of a SAVED, non-empty chat outside the page. */
const hydratingSaved = (overrides = {}) => {
  const record = {
    agent_build_started: false, agent_ready: false, history: [], resume_hydrating: true,
    resume_message_count: RESUME_MESSAGES, running: false, session_key: RESUME_ID,
    sid: RESUME_RUNTIME
  }

  return draft({
    focus: focusState(OWNER, RESUME_ID, RESUME_RUNTIME),
    // The saved chat sits outside the returned page (201st row / archived scope).
    sessions: () => [...fullPage(), { id: RESUME_ID, profile: 'default', cwd: '/srv/projects/repos/saved', message_count: RESUME_MESSAGES }].slice(0, POPULATION),
    live: () => [nativeLiveRow(record, RESUME_RUNTIME)],
    history: () => ({ count: RESUME_MESSAGES, messages: [{ role: 'user', text: 'saved turn' }] }),
    ...overrides
  })
}

test('full window: a hydrating saved chat is not opened as a plain new chat (same profile)', async () => {
  const h = await hydratingSaved()
  await select(h, true)
  assert.equal(h.calls.length, 0, 'a saved chat must never be replaced by an empty one')
  assert.equal(h.creates.length + h.titles.length + h.opens.length, 0)
  assert.ok(!messages(h).some(message => /empty/i.test(message)), JSON.stringify(messages(h)))
  assert.equal(h.liveCalls.length, 1)
  assert.equal(h.histories.length, 1, 'the persistent door must be consulted before any claim of emptiness')
  h.dispose()
})

for (const action of ['Start fresh', 'Copy context', 'Brief handoff']) {
  test(`full window: a hydrating saved chat is not carried as empty (${action})`, async () => {
    const h = await hydratingSaved()
    await select(h)
    await commit(h, action)
    assert.equal(h.calls.length, 0, 'no plain new chat for a saved chat')
    assert.equal(h.creates.length + h.titles.length + h.opens.length, 0)
    assert.ok(!messages(h).some(message => /empty/i.test(message)),
      `the user must not be told a saved chat is empty: ${JSON.stringify(messages(h))}`)
    assert.equal(h.histories.length, 1)
    h.dispose()
  })
}

for (const [name, history] of [
  ['an unreadable persistent door', () => { throw new Error('history timed out') }],
  ['a persistent door with messages', () => ({ count: 3, messages: [{ role: 'user', text: 'x' }] })],
  ['a malformed persistent answer', () => ({ count: '0', messages: [] })],
  ['a persistent answer without a count', () => ({ messages: [] })],
  ['a typed-but-negative count', () => ({ count: -1, messages: [] })]
]) {
  test(`two doors: ${name} refuses instead of opening an empty chat`, async () => {
    const h = await hydratingSaved({ history })
    await select(h, true)
    assert.equal(h.calls.length, 0)
    assert.equal(h.creates.length + h.titles.length + h.opens.length, 0)
    assert.ok(messages(h).length > 0, 'the refusal is visible')
    h.dispose()
  })
}

test('two doors: a missing persistent door refuses instead of opening an empty chat', async () => {
  const h = await hydratingSaved({ history: undefined })
  await select(h, true)
  assert.equal(h.calls.length, 0)
  h.dispose()
})

test('navigation during the live-roster read opens nothing', async () => {
  const gate = deferred()
  const h = await draft({ live: () => gate.promise })
  await select(h, true)
  await h.settle()
  h.focus.storedId('elsewhere')
  gate.resolve([liveRow()])
  await rounds(h)
  assert.equal(h.calls.length, 0)
  assert.equal(h.creates.length, 0)
  h.dispose()
})

test('leaving and returning to the same chat during the live-roster read opens nothing', async () => {
  const gate = deferred()
  const h = await draft({ live: () => gate.promise })
  await select(h, true)
  await h.settle()
  h.focus.storedId('elsewhere')
  h.focus.storedId(DRAFT_ID)
  gate.resolve([liveRow()])
  await rounds(h)
  assert.equal(h.calls.length, 0, 'an away-and-back focus change still invalidates the intent')
  assert.equal(h.creates.length, 0)
  h.dispose()
})

test('disposal during the live-roster read opens nothing', async () => {
  const gate = deferred()
  const h = await draft({ live: () => gate.promise })
  await select(h, true)
  await h.settle()
  h.dispose()
  gate.resolve([liveRow()])
  await rounds(h)
  assert.equal(h.calls.length, 0)
})

test('a route that vanishes during the live-roster read opens nothing', async () => {
  const gate = deferred()
  const h = await draft({ live: () => gate.promise })
  await select(h, true)
  await h.settle()
  h.reader(async () => [{ ...SOURCE, targetProfile: 'changed' }, TARGET])
  gate.resolve([liveRow()])
  await rounds(h)
  assert.equal(h.calls.length, 0, 'the refreshed descriptor is re-validated before the chat opens')
  h.dispose()
})
