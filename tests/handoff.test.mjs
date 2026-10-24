// D19 stage 1: context resolution + the write path that inherits a project into
// a new chat on another profile. The SDK/React doubles come from tests/harness.mjs
// and are explicitly mocks: no Electron, no gateway, no model call is involved.
import test from 'node:test'
import assert from 'node:assert/strict'

import { harness, route, focusState, deferred } from './harness.mjs'

const CWD = '/srv/projects/repos/demo'
const SOURCE = route('local', 'default')
const TARGET = route('local', 'coder')
const SOURCE_OWNER = { connectionId: 'local', profile: 'default' }

const trunkLane = path => ({ id: path, label: 'main', path, isMain: true, isKanban: false, isGit: true })
const named = ({ id = 'p-demo', path = CWD, sessionIds = [], groups } = {}) => ({
  id,
  label: 'demo',
  path,
  color: null,
  icon: null,
  isAuto: false,
  isNoProject: false,
  sessionCount: sessionIds.length,
  lastActive: 0,
  repos: [{ id: path, label: 'demo', path, sessionCount: sessionIds.length, groups: groups ?? [trunkLane(path)] }],
  previewSessions: [],
  sessionIds
})
const auto = ({ id = CWD, path = CWD, sessionIds = [] } = {}) => ({ ...named({ id, path, sessionIds }), isAuto: true })

const sourceRow = { id: 'src-1', cwd: CWD, profile: 'default', message_count: 4, source: 'desktop' }
const newRow = { id: 'new-1', cwd: CWD, profile: 'coder', message_count: 0, source: 'desktop' }
const created = { session_id: 'rt-new', stored_session_id: 'new-1', message_count: 0, messages: [], info: {} }

/** A mounted picker whose focused chat is a stored session with a confirmed owner. */
const standard = (overrides = {}) => harness({
  routes: [SOURCE, TARGET],
  focus: focusState({ ...SOURCE_OWNER }, 'src-1', 'rt-src'),
  sessions: r => (r.profile === 'default' ? [sourceRow] : [newRow]),
  projects: r => [r.profile === 'default' ? named({ sessionIds: ['src-1'] }) : named()],
  create: () => ({ ...created }),
  title: () => ({ pending: false }),
  openSession: async () => {},
  ...overrides
})

/** Select the named row and, when the handoff dialog appears, activate a variant. */
const choose = async (h, profile = 'coder', action = 'Start fresh') => {
  await h.open()
  const item = h.items().find(node => h.text(node).includes(profile))
  assert.ok(item, `the ${profile} row must be offered`)
  h.select(item)

  for (let round = 0; round < 4; round += 1) await h.settle()

  if (h.dialogOpen()) {
    h.dialogAction(action).props.onClick()

    for (let round = 0; round < 6; round += 1) await h.settle()
  }

  return item
}
/** Select a row and leave the stage-2 dialog open for the test to drive. */
const pickProfile = async (h, profile = 'coder') => {
  await h.open()
  const item = h.items().find(node => h.text(node).includes(profile))
  assert.ok(item, `the ${profile} row must be offered`)
  h.select(item)

  for (let round = 0; round < 4; round += 1) await h.settle()

  return item
}
const messages = h => h.notices.map(notice => String(notice.message))
// Descriptors handed to the mocked host come from the entry's own VM realm, so
// structural assertions compare plain JSON copies on both sides.
const plain = value => JSON.parse(JSON.stringify(value))

// ── resolution: supported topologies ────────────────────────────────────────

test('a confirmed source project is inherited: one create, one read-back, one open, no newChat', async () => {
  const order = []
  const h = await standard({
    sessions: r => { order.push(`read:${r.profile}`); return r.profile === 'default' ? [sourceRow] : [newRow] },
    projects: r => { order.push(`tree:${r.profile}`); return [r.profile === 'default' ? named({ sessionIds: ['src-1'] }) : named()] },
    create: () => { order.push('create'); return { ...created } },
    title: () => { order.push('title'); return { pending: false } },
    openSession: async () => { order.push('open') }
  })
  await choose(h)

  assert.deepEqual(plain(order), ['read:default', 'tree:default', 'tree:coder', 'create', 'title', 'read:coder', 'open'])
  assert.deepEqual(h.treeCalls.map(call => [call.route.profile, call.params.profile, call.params.preview_limit]), [
    ['default', 'default', 0],
    ['coder', 'coder', 0]
  ], 'each tree read is scoped to its own route profile')
  assert.deepEqual(h.calls, [], 'the handoff path never falls back to newChat')
  assert.deepEqual(h.notices, [], 'a supported handoff reports no error')
  h.dispose()
})

test('the target may be an automatic group for the same folder (named+auto merge case)', async () => {
  const h = await standard({ projects: r => [r.profile === 'default' ? named({ sessionIds: ['src-1'] }) : auto()] })
  await choose(h)
  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 1)
  assert.deepEqual(h.notices, [])
  h.dispose()
})

// Native build_tree(hydrate=false) keeps repo counts but clears group sessions.
// In particular, declared folders with no loaded rows have no fabricated main group.
const nativeProject = ({ ids = [], branches = [], auto = false, count = ids.length } = {}) => ({
  ...named({ id: auto ? CWD : 'p-demo', sessionIds: ids, groups: branches.map(label => ({
    ...trunkLane(CWD), id: `${CWD}::branch::${label}`, label, sessions: []
  })) }),
  isAuto: auto,
  sessionCount: count
})

for (const [kind, auto, count] of [['declared', false, 0], ['discovered', true, 7]]) {
  test(`native empty ${kind} target passes selection/dialog/create/title/readback/open`, async () => {
    const order = []
    const h = await standard({
      sessions: r => { order.push(`read:${r.profile}`); return r.profile === 'default' ? [sourceRow] : [newRow] },
      projects: r => [r.profile === 'default'
        ? nativeProject({ ids: ['src-1'], branches: ['task/source'] })
        : nativeProject({ auto, count })],
      create: () => { order.push('create'); return { ...created } },
      title: () => { order.push('title'); return { pending: false } },
      openSession: async () => { order.push('open') }
    })
    await pickProfile(h)
    assert.equal(h.dialogOpen(), true)
    h.dialogAction('Start fresh').props.onClick()
    for (let round = 0; round < 6; round += 1) await h.settle()
    assert.deepEqual(messages(h), [])
    assert.deepEqual(order, ['read:default', 'create', 'title', 'read:coder', 'open'])
    assert.equal(h.creates[0].params.cwd, CWD)
    assert.equal(h.opens[0].storedId, 'new-1')
    assert.deepEqual(h.calls, [])
    h.dispose()
  })
}

for (const side of ['source', 'target']) {
  test(`native multiple root-checkout branch groups on ${side} are not multiple folders`, async () => {
    const h = await standard({ projects: r => [nativeProject({
      ids: r.profile === 'default' ? ['src-1', 'src-2'] : ['old-1', 'old-2'],
      branches: (r.profile === 'default') === (side === 'source') ? ['task/one', 'release/two'] : ['task/one']
    })] })
    await choose(h)
    assert.deepEqual(messages(h), [])
    assert.equal(h.creates.length, 1)
    assert.equal(h.opens.length, 1)
    assert.deepEqual(h.calls, [])
    h.dispose()
  })
}

// Refuse malformed or contradictory metadata before creating, titling or opening.
const laneRefusals = [
  ['missing groups', p => { delete p.repos[0].groups }],
  ['null groups', p => { p.repos[0].groups = null }],
  ['object groups', p => { p.repos[0].groups = {} }],
  ['string groups', p => { p.repos[0].groups = 'main' }],
  ['no groups with positive repo count', p => { p.repos[0].groups = [] }],
  ['no groups with missing repo count', p => { p.repos[0].groups = []; delete p.repos[0].sessionCount }],
  ['no groups with string repo count', p => { p.repos[0].groups = []; p.repos[0].sessionCount = '0' }],
  ['no groups with negative repo count', p => { p.repos[0].groups = []; p.repos[0].sessionCount = -1 }],
  ['null group', p => { p.repos[0].groups = [null] }],
  ['array group', p => { p.repos[0].groups = [[]] }],
  ['string group', p => { p.repos[0].groups = ['main'] }],
  ['empty group object', p => { p.repos[0].groups = [{}] }],
  ['missing main flag', p => { delete p.repos[0].groups[0].isMain }],
  ['missing kanban flag', p => { delete p.repos[0].groups[0].isKanban }],
  ['kanban flag conflicting with main', p => { p.repos[0].groups[0].isKanban = true }],
  ['non-main root checkout', p => { p.repos[0].groups[0].isMain = false }],
  ['worktree sibling', p => { p.repos[0].groups[1] = { ...trunkLane(`${CWD}/.worktrees/task`), isMain: false } }],
  ['kanban sibling', p => { p.repos[0].groups[1] = { ...trunkLane(`${CWD}/.worktrees`), isMain: false, isKanban: true } }],
  ['foreign root sibling', p => { p.repos[0].groups[1].path = '/srv/projects/repos/other' }],
  ['missing group path', p => { delete p.repos[0].groups[0].path }],
  ['repo root conflicts with project', p => { p.repos[0].path = '/srv/projects/repos/other' }],
  ['multi-folder project', p => { p.repos.push({ ...p.repos[0], id: '/other', path: '/other' }) }]
]
for (const side of ['source', 'target']) {
  for (const [name, mutate] of laneRefusals) {
    test(`native ${side} refusal: ${name}`, async () => {
      const node = nativeProject({ ids: ['src-1', 'src-2'], branches: ['task/one', 'release/two'] })
      mutate(node)
      const h = await standard({ projects: r => [
        (r.profile === 'default') === (side === 'source') ? node : nativeProject({ ids: ['src-1'], branches: ['task/one'] })
      ] })
      await choose(h)
      assert.ok(messages(h).some(message => /structure could not be confirmed|more than one folder/i.test(message)), JSON.stringify(messages(h)))
      assert.equal(h.creates.length, 0)
      assert.equal(h.titles.length, 0)
      assert.equal(h.opens.length, 0)
      assert.deepEqual(h.calls, [])
      h.dispose()
    })
  }
}

for (const [name, side, mutate] of [
  ['empty source with claimed stored row', 'source', p => { p.repos[0].groups = []; p.repos[0].sessionCount = 0 }],
  ['source groups contradict zero loaded repo count', 'source', p => { p.repos[0].sessionCount = 0 }],
  ['source membership absent despite matching folder', 'source', p => { p.sessionIds = [] }],
  ['empty target contradicts claimed loaded rows', 'target', p => { p.repos[0].groups = []; p.repos[0].sessionCount = 0 }]
]) {
  test(`native contradiction: ${name}`, async () => {
    const node = nativeProject({ ids: ['src-1'], branches: ['task/one'] })
    mutate(node)
    const h = await standard({ projects: r => [
      (r.profile === 'default') === (side === 'source') ? node : nativeProject({ ids: ['src-1'], branches: ['task/one'] })
    ] })
    await choose(h)
    assert.ok(messages(h).some(message => /structure could not be confirmed/i.test(message)), JSON.stringify(messages(h)))
    assert.equal(h.creates.length, 0)
    assert.equal(h.titles.length, 0)
    assert.equal(h.opens.length, 0)
    assert.deepEqual(h.calls, [])
    h.dispose()
  })
}

// ── resolution: refusals, always before any write ───────────────────────────

const refusals = [
  {
    name: 'the focused session row is missing from the bounded window',
    override: { sessions: r => (r.profile === 'default' ? [{ ...sourceRow, id: 'someone-else' }] : [newRow]) },
    text: /no stored session row/i
  },
  {
    name: 'the focused row has a blank cwd',
    override: { sessions: r => (r.profile === 'default' ? [{ ...sourceRow, cwd: '   ' }] : [newRow]) },
    text: /no recorded folder/i
  },
  {
    name: 'the bounded window is saturated without the focused row',
    override: {
      sessions: r => (r.profile === 'default'
        ? Array.from({ length: 200 }, (_, index) => ({ ...sourceRow, id: `other-${index}` }))
        : [newRow])
    },
    text: /recent session window/i
  },
  {
    name: 'the focused row is stamped with another profile',
    override: { sessions: r => (r.profile === 'default' ? [{ ...sourceRow, profile: 'archive' }] : [newRow]) },
    text: /profile mapping/i
  },
  {
    name: 'the persisted lookup cannot be read',
    override: { sessions: () => { throw new Error('state.db offline') } },
    text: /session list could not be read/i
  },
  {
    name: 'the source project spans several folders',
    override: {
      projects: r => [r.profile === 'default'
        ? { ...named({ sessionIds: ['src-1'] }), repos: [...named({ sessionIds: ['src-1'] }).repos, { id: '/other', path: '/other', groups: [trunkLane('/other')] }] }
        : named()]
    },
    text: /more than one folder/i
  },
  {
    name: 'the source folder has no project at all',
    override: { projects: r => (r.profile === 'default' ? [named({ id: 'p-other', path: '/srv/projects/repos/other', sessionIds: [] })] : [named()]) },
    text: /not a project on its source/i
  },
  {
    name: 'two source projects claim the focused row',
    override: {
      projects: r => (r.profile === 'default'
        ? [named({ sessionIds: ['src-1'] }), named({ id: 'p-second', sessionIds: ['src-1'] })]
        : [named()])
    },
    text: /more than one project/i
  },
  {
    name: 'the focused session sits in a non-trunk (worktree) lane',
    override: {
      projects: r => [r.profile === 'default'
        ? named({ sessionIds: ['src-1'], groups: [{ ...trunkLane(`${CWD}/.worktrees/task`), isMain: false }] })
        : named()]
    },
    text: /project structure could not be confirmed/i
  },
  {
    name: 'the source project list cannot be read',
    override: { projects: r => { if (r.profile === 'default') throw new Error('projects offline'); return [named()] } },
    text: /project list could not be read/i
  },
  {
    name: 'the target profile has no project for this folder',
    override: { projects: r => (r.profile === 'default' ? [named({ sessionIds: ['src-1'] })] : []) },
    text: /no project for this folder/i
  },
  {
    name: 'the target carries a different named project for this folder',
    override: {
      projects: r => [r.profile === 'default' ? named({ sessionIds: ['src-1'] }) : named({ id: 'p-foreign', label: 'foreign' })]
    },
    text: /different project for this folder/i
  },
  {
    name: 'two target projects match this folder',
    override: {
      projects: r => (r.profile === 'default'
        ? [named({ sessionIds: ['src-1'] })]
        : [auto(), auto({ id: 'p-demo' })])
    },
    text: /more than one project/i
  },
  {
    name: 'the target project structure is unconfirmed',
    override: {
      projects: r => [r.profile === 'default' ? named({ sessionIds: ['src-1'] }) : named({ groups: [{ ...trunkLane(CWD), isMain: false }] })]
    },
    text: /project structure could not be confirmed/i
  }
]

for (const { name, override, text } of refusals) {
  test(`refusal: ${name}`, async () => {
    const h = await standard(override)
    await choose(h)
    assert.ok(messages(h).some(message => text.test(message)), `expected a ${text} notice, got ${JSON.stringify(messages(h))}`)
    assert.equal(h.creates.length, 0, 'a refused handoff never creates anything')
    assert.equal(h.opens.length, 0, 'a refused handoff never opens anything')
    assert.deepEqual(h.calls, [], 'a refused handoff never falls back to newChat')
    h.dispose()
  })
}

test('an ambiguous or absent source route is refused before any project read', async () => {
  const ambiguous = await standard({ routes: [SOURCE, { ...SOURCE }, TARGET] })
  await choose(ambiguous)
  assert.ok(messages(ambiguous).some(message => /source is ambiguous/i.test(message)))
  assert.equal(ambiguous.rpcCalls.length, 0)

  const gone = await standard({ routes: [TARGET] })
  await choose(gone)
  assert.ok(messages(gone).some(message => /source that is no longer available/i.test(message)))
  assert.equal(gone.creates.length, 0)

  ambiguous.dispose()
  gone.dispose()
})

// ── the write path payload ─────────────────────────────────────────────────

test('create carries the validated route, cwd and flags, never a parent session', async () => {
  const h = await standard()
  await choose(h)

  assert.equal(h.creates.length, 1)
  const { params: createParams, route: createRoute, timeoutMs } = h.creates[0]
  assert.deepEqual(plain(createRoute), TARGET)
  assert.equal(timeoutMs, 60000, 'minting may outlast the pool default deadline')
  assert.equal(createParams.profile, 'coder')
  assert.equal(createParams.source, 'desktop')
  assert.equal(createParams.cwd, CWD)
  assert.equal(createParams.cwd_explicit, true)
  assert.equal(createParams.hidden, false)
  assert.equal(createParams.follow_profile_config, true)
  assert.equal(createParams.close_on_disconnect, false)
  assert.equal(typeof createParams.title, 'string')
  assert.ok(createParams.title.trim(), 'the create carries an explicit title')
  assert.ok(!('parent_session_id' in createParams), 'a handoff is never a child session')
  assert.ok(!('messages' in createParams), 'an unseeded create sends no messages')
  assert.equal(typeof createParams.idempotency_key, 'string')
  assert.match(createParams.idempotency_key, /^hermes-profile-switcher#/)
  h.dispose()
})

test('each operation uses its own stable idempotency key', async () => {
  const h = await standard()
  await choose(h)
  const first = h.creates[0].params.idempotency_key
  assert.equal(typeof first, 'string')
  await choose(h)
  const second = h.creates[1].params.idempotency_key
  assert.notEqual(first, second, 'a second operation must not reuse the key')
  assert.equal(h.creates.length, 2)
  h.dispose()
})

test('session.title materialises only an empty create, on the runtime id our create returned', async () => {
  const h = await standard()
  await choose(h)
  assert.equal(h.titles.length, 1)
  const { params: titleParams, route: titleRoute } = h.titles[0]
  assert.deepEqual(plain(titleRoute), TARGET)
  assert.equal(titleParams.session_id, 'rt-new', 'title targets the runtime id of our own new session')
  assert.equal(titleParams.title, h.creates[0].params.title)
  h.dispose()
})

test('a seeded create sends the seed, skips title and asks for history', async () => {
  const h = await standard()
  const write = h.namespace.handoff
  assert.ok(write, 'the entry exports its handoff helpers for direct contract tests')

  const seed = { messages: [{ role: 'user', content: 'hello' }] }
  const seen = []
  const outcome = await write.openInheritedChat({
    host: {
      requestProfile: async (_route, method, params) => {
        seen.push([method, params])

        if (method === 'session.create') return { session_id: 'rt-2', stored_session_id: 'new-2' }

        throw new Error(`unexpected ${method}`)
      },
      listPersistedSessions: async () => ({ sessions: [{ id: 'new-2', cwd: CWD, profile: 'coder', message_count: 1 }] }),
      openSession: async (storedId, options) => { seen.push(['open', { storedId, ...options }]) }
    },
    context: { target: { route: TARGET, cwd: CWD } },
    seed,
    key: 'test-key',
    isCurrent: () => true
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.storedId, 'new-2')
  assert.deepEqual(seen.map(step => step[0]), ['session.create', 'open'], 'a seeded create needs no title call')
  const [, params] = seen[0]
  assert.deepEqual(params.messages, seed.messages)
  assert.equal(params.idempotency_key, 'test-key')
  assert.ok(!('parent_session_id' in params))
  assert.deepEqual(plain(seen[1][1]), { storedId: 'new-2', route: TARGET, awaitHydration: true, expectHistory: true })
  h.dispose()
})

test('the durable read-back must match the stored id, cwd and message count', async () => {
  for (const row of [
    undefined,
    { id: 'new-1', cwd: '/srv/projects/repos/other', profile: 'coder', message_count: 0 },
    { id: 'new-1', cwd: CWD, profile: 'coder', message_count: 3 }
  ]) {
    const h = await standard({ sessions: r => (r.profile === 'default' ? [sourceRow] : row ? [row] : []) })
    await choose(h)
    assert.equal(h.creates.length, 1, 'the create is never repeated')
    assert.equal(h.opens.length, 0, 'an unconfirmed create is never opened')
    assert.ok(messages(h).some(message => /could not be confirmed/i.test(message)), JSON.stringify(messages(h)))
    h.dispose()
  }
})

test('openSession asks for hydration and history exactly as the seed requires', async () => {
  const h = await standard()
  await choose(h)
  assert.equal(h.opens.length, 1)
  const { options, storedId } = h.opens[0]
  assert.equal(storedId, 'new-1')
  assert.equal(options.awaitHydration, true)
  assert.equal(options.expectHistory, false, 'an unseeded handoff expects no history')
  assert.deepEqual(plain(options.route), TARGET)
  h.dispose()
})

test('a create success with a failing open keeps the ids and retries only the open', async () => {
  let attempts = 0
  const h = await standard({
    openSession: async () => { attempts += 1; if (attempts === 1) throw new Error('hydration timed out') }
  })
  await choose(h)

  assert.equal(h.creates.length, 1, 'the create is never repeated after an open failure')
  assert.equal(h.opens.length, 2, 'the open itself is retried once')
  assert.deepEqual(plain(h.opens[0]), plain(h.opens[1]), 'the retry reuses the exact ids and the exact call')
  assert.deepEqual(h.notices, [], 'the retried open succeeded, so nothing is reported')
  h.dispose()
})

test('a repeatedly failing open reports once and never re-creates', async () => {
  const h = await standard({ openSession: async () => { throw new Error('hydrate failed') } })
  await choose(h)
  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 2)
  assert.ok(messages(h).some(message => /could not be opened/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('an unclear create outcome is a reconciliation refusal, not a blind retry', async () => {
  const h = await standard({ create: () => { throw new Error('response lost in transit') } })
  await choose(h)
  assert.equal(h.creates.length, 1, 'the create is attempted exactly once')
  assert.equal(h.titles.length, 0)
  assert.equal(h.opens.length, 0)
  assert.equal(h.persisted.length, 1, 'only the source lookup was read')
  assert.ok(messages(h).some(message => /could not confirm whether the new chat was created/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('a create answer without usable ids is refused instead of being opened', async () => {
  const h = await standard({ create: () => ({ session_id: '', stored_session_id: 'new-1' }) })
  await choose(h)
  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 0)
  assert.ok(messages(h).some(message => /could not confirm whether/i.test(message)))
  h.dispose()
})

// ── liveness, duplicates and drift ─────────────────────────────────────────

test('two rapid selections start a single handoff operation', async () => {
  const gate = deferred()
  const h = await standard({ create: () => gate.promise.then(() => ({ ...created })) })
  await h.open()
  const item = h.items().find(node => h.text(node).includes('coder'))
  h.select(item)
  h.select(item)
  h.select(item)
  await h.settle()
  assert.equal(h.creates.length, 0, 'the create has not been asked for yet')
  assert.equal(h.dialogOpen(), true, 'a different confirmed profile asks through the dialog')
  h.dialogAction('Start fresh').props.onClick()
  h.dialogAction('Start fresh').props.onClick()
  h.dialogAction('Start fresh').props.onClick()
  await h.settle()
  gate.resolve()

  for (let round = 0; round < 6; round += 1) await h.settle()

  assert.equal(h.creates.length, 1, 'concurrent clicks produce one create')
  assert.equal(h.opens.length, 1)
  h.dispose()
})

test('a source change during verification is refused before any write', async () => {
  const gate = deferred()
  const h = await standard({
    projects: r => (r.profile === 'default' ? gate.promise.then(() => [named({ sessionIds: ['src-1'] })]) : Promise.resolve([named()]))
  })
  await pickProfile(h)
  assert.equal(h.dialogOpen(), true)
  h.dialogAction('Start fresh').props.onClick()
  await h.settle()
  h.focus.storedId('src-other')
  gate.resolve()

  for (let round = 0; round < 6; round += 1) await h.settle()

  assert.equal(h.creates.length, 0)
  assert.equal(h.opens.length, 0)
  assert.ok(messages(h).some(message => /changed while/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('a handoff abandoned by disposal or unmount never opens a late chat', async () => {
  for (const stop of ['dispose', 'unmount']) {
    const gate = deferred()
    const h = await standard({ create: () => gate.promise.then(() => ({ ...created })) })
    await pickProfile(h)
    h.dialogAction('Start fresh').props.onClick()

    for (let round = 0; round < 3; round += 1) await h.settle()

    assert.equal(h.creates.length, 1)
    h[stop]()
    gate.resolve()

    for (let round = 0; round < 6; round += 1) await h.settle()

    assert.equal(h.titles.length, 0, 'nothing after an abandoned create is issued')
    assert.equal(h.opens.length, 0, 'an abandoned handoff never opens a chat')
    assert.deepEqual(h.notices, [], 'a user-initiated stop is not an error')
  }
})

// ── honest fallbacks: no confirmed source context ───────────────────────────

test('an empty draft keeps the previous honest new-chat behaviour', async () => {
  for (const [owner, storedId] of [[SOURCE_OWNER, null], [SOURCE_OWNER, ''], [null, 'src-1'], [{}, 'src-1']]) {
    const h = await harness({
      routes: [SOURCE, TARGET],
      focus: focusState(owner, storedId),
      sessions: () => [sourceRow],
      projects: () => [named({ sessionIds: ['src-1'] })]
    })
    await choose(h)
    assert.equal(h.calls.length, 1, 'a chat is still opened on the chosen profile')
    assert.deepEqual(h.calls[0][0], TARGET)
    assert.equal(h.persisted.length, 0, 'no project context is looked up without a confirmed source')
    assert.equal(h.treeCalls.length, 0)
    h.dispose()
  }
})

test('a build without the handoff doors keeps the plain new-chat path', async () => {
  for (const missing of ['host.requestProfile', 'host.listPersistedSessions', 'host.openSession', 'state.focusedSessionId']) {
    const h = await harness({
      routes: [SOURCE, TARGET],
      missing,
      focus: focusState({ ...SOURCE_OWNER }, 'src-1'),
      sessions: () => [sourceRow],
      projects: () => [named({ sessionIds: ['src-1'] })]
    })
    await choose(h)
    assert.equal(h.calls.length, 1, `${missing} must not break the action`)
    assert.deepEqual(h.calls[0][0], TARGET)
    h.dispose()
  }
})

test('the handoff path reads only the three readonly atoms and the public doors', async () => {
  const h = await standard()
  await choose(h)
  assert.deepEqual(h.stateAccesses, ['focusedSessionOwner', 'focusedStoredSessionId', 'focusedSessionId'])
  assert.ok(!h.stateAccesses.includes('cwd'), 'the global workspace cwd is never read')
  // `newChat` is read once by the register-time capability probe and never called.
  assert.deepEqual(
    [...h.hostAccesses].sort(),
    ['listPersistedSessions', 'newChat', 'openSession', 'profileRoutes', 'requestProfile', 'state']
  )
  assert.equal(h.calls.length, 0, 'the handoff path never opens a plain new chat')
  for (const forbidden of ['submit', 'steer', 'model', 'stateCwd']) {
    assert.ok(!h.hostAccesses.includes(forbidden), `${forbidden} must never be touched`)
  }
  h.dispose()
})

// ── the resolvers, directly ────────────────────────────────────────────────

test('the exported resolver is typed, synchronous on the snapshot and fail-closed', async () => {
  const h = await harness()
  const { sourceSnapshot, resolveInheritedProject, REFUSALS } = h.namespace.handoff
  assert.equal(typeof sourceSnapshot, 'function')
  assert.equal(typeof resolveInheritedProject, 'function')

  const snapshot = sourceSnapshot(h.sdk.host)
  assert.deepEqual(plain(snapshot), { runtimeId: 'runtime-chat', storedId: 'stored-chat', owner: null })

  const refused = await resolveInheritedProject({
    host: h.sdk.host,
    routes: [SOURCE, TARGET],
    target: TARGET,
    snapshot: { runtimeId: 'rt', storedId: 'src-1', owner: null }
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'source-owner')
  assert.equal(typeof REFUSALS[refused.code], 'string')
  assert.equal(h.persisted.length, 0, 'nothing is read for an unconfirmed source identity')
  h.dispose()
})

test('a Windows-style folder is compared by its canonical key, not by raw bytes', async () => {
  const win = 'C:\\Projects\\Demo'
  const node = { ...named({ id: 'p-win', path: win, sessionIds: ['src-win'] }) }
  node.repos[0] = { ...node.repos[0], id: win, path: win, groups: [{ ...trunkLane(win), path: win }] }

  const h = await standard({
    focus: focusState({ ...SOURCE_OWNER }, 'src-win', 'rt-src'),
    sessions: r => (r.profile === 'default'
      ? [{ id: 'src-win', cwd: 'c:/projects/demo/', profile: 'default', message_count: 2 }]
      : [{ id: 'new-1', cwd: 'C:\\projects\\demo', profile: 'coder', message_count: 0 }]),
    projects: r => (r.profile === 'default' ? [node] : [{ ...node, isAuto: true, id: win }])
  })
  await choose(h)

  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.cwd, 'c:/projects/demo/')
  assert.deepEqual(h.notices, [])
  h.dispose()
})

test('the resolver returns the confirmed source and target identity, and nothing global', async () => {
  const h = await standard()
  const { resolveInheritedProject } = h.namespace.handoff
  const resolved = await resolveInheritedProject({
    host: h.sdk.host,
    routes: [SOURCE, TARGET],
    target: TARGET,
    snapshot: { runtimeId: 'rt-src', storedId: 'src-1', owner: { ...SOURCE_OWNER } }
  })

  assert.equal(resolved.ok, true)
  assert.equal(resolved.source.cwd, CWD)
  assert.equal(resolved.source.storedId, 'src-1')
  assert.equal(resolved.source.projectId, 'p-demo')
  assert.deepEqual(plain(resolved.source.route), SOURCE)
  assert.deepEqual(plain(resolved.target.route), TARGET)
  assert.equal(resolved.target.cwd, CWD)
  assert.equal(resolved.target.projectId, 'p-demo')
  assert.equal(resolved.target.projectKind, 'named')
  assert.deepEqual(plain(resolved.seed), { messages: [] }, 'stage 1 inherits the project only')
  assert.equal(h.persisted[0].options.profile, 'default', 'the read is scoped to the source backend profile')
  assert.equal(h.persisted[0].options.limit, h.namespace.handoff.LOOKUP_LIMIT)
  h.dispose()
})
