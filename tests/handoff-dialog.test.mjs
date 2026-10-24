// D19 stage 2: the three-way handoff — the history tail reader, the local
// seed/brief builders and the dialog that selects between them. The SDK/React
// doubles come from tests/harness.mjs and are explicitly mocks: no Electron, no
// gateway, no Radix, no model and no network call is involved.
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

const sourceRow = { id: 'src-1', cwd: CWD, profile: 'default', title: 'Demo work', message_count: 4, source: 'desktop' }
const newRow = { id: 'new-1', cwd: CWD, profile: 'coder', message_count: 0, source: 'desktop' }
const created = { session_id: 'rt-new', stored_session_id: 'new-1', message_count: 0, messages: [], info: {} }

const user = text => ({ role: 'user', text })
const assistant = (text, extra = {}) => ({ role: 'assistant', text, reasoning: 'hidden reasoning', ...extra })

/** Rows the gateway's own display projection would never carry as real words. */
const NOISE = [
  { role: 'user', text: 'scaffolding', display_kind: 'hidden' },
  { role: 'tool', name: 'read_file', text: 'raw file bytes', tool_call_id: 'tc-1', args: { path: 'a' } },
  { role: 'system', text: 'you are a helpful bot' },
  { role: 'user', text: '[System: model switched to x]' },
  { role: 'user', text: '   ' },
  { role: 'assistant', text: '' },
  { role: 'user', text: undefined, content: [{ type: 'image', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  { role: 'assistant', text: 'call', tool_call_id: 'tc-2' },
  { role: 'user', text: 'untyped row', name: 'bridge' }
]

/** A mounted picker whose focused chat is a stored session with a confirmed owner. */
const standard = (overrides = {}) => harness({
  routes: [SOURCE, TARGET],
  focus: focusState({ ...SOURCE_OWNER }, 'src-1', 'rt-src'),
  sessions: r => (r.profile === 'default' ? [sourceRow] : [newRow]),
  projects: r => [r.profile === 'default' ? named({ sessionIds: ['src-1'] }) : named()],
  history: () => ({ count: 2, messages: [user('hello'), assistant('hi there')] }),
  create: () => ({ ...created }),
  title: () => ({ pending: false }),
  openSession: async () => {},
  ...overrides
})

/** Select the chosen row; when the handoff dialog appears, activate `action`. */
const LABELS = { copy: 'Copy context', brief: 'Brief handoff', fresh: 'Start fresh', cancel: 'Cancel' }

const choose = async (h, profile = 'coder', action = 'fresh') => {
  await h.open()
  const item = h.items().find(node => h.text(node).includes(profile))
  assert.ok(item, `the ${profile} row must be offered`)
  h.select(item)

  for (let round = 0; round < 4; round += 1) await h.settle()

  if (h.dialogOpen()) {
    if (action === 'cancel' || action === 'dismiss') {
      if (action === 'cancel') h.dialogAction(LABELS.cancel).props.onClick()
      else h.dismissDialog()
    } else {
      h.dialogAction(LABELS[action]).props.onClick()
    }

    for (let round = 0; round < 6; round += 1) await h.settle()
  }

  return item
}
const messages = h => h.notices.map(notice => String(notice.message))
const plain = value => JSON.parse(JSON.stringify(value))

// ── the history tail reader ────────────────────────────────────────────────

test('readTail reads the source history through the public door and keeps only visible words', async () => {
  const h = await standard({
    history: () => ({
      count: NOISE.length + 3,
      messages: [
        NOISE[0], user('first question'), NOISE[1], assistant('first answer'), NOISE[3],
        NOISE[6], NOISE[7], user('second question'), NOISE[8], assistant('second answer')
      ]
    })
  })
  const tail = await h.namespace.handoff.readTail(h.sdk.host, SOURCE, 'rt-src')

  assert.equal(tail.ok, true)
  assert.deepEqual(plain(tail.messages), [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
    { role: 'user', text: 'second question' },
    { role: 'assistant', text: 'second answer' }
  ], 'hidden, tool, system, notice, blank and attachment rows are not copied, and the order is kept')
  assert.equal(tail.omitted, 0)
  assert.equal(tail.clipped, false)
  assert.ok(!/Copy cap/.test(tail.provenance), 'an untruncated copy carries no cap note')

  assert.equal(h.histories.length, 1)
  const call = h.histories[0]
  assert.equal(h.rpcCalls.filter(item => item.method === 'session.history').length, 1)
  assert.equal(call.params.session_id, 'rt-src')
  assert.equal(call.params.profile, 'default', 'the read is scoped to the source backend profile')
  assert.deepEqual(plain(call.route), SOURCE)
  assert.equal(h.creates.length, 0, 'reading the tail writes nothing')
  assert.equal(h.calls.length, 0)
  h.dispose()
})

test('the tail carries a provenance note that attributes the copied replies to the source profile', async () => {
  const h = await standard()
  const tail = await h.namespace.handoff.readTail(h.sdk.host, SOURCE, 'rt-src')

  assert.match(tail.provenance, /default/, 'the source profile is named')
  assert.match(tail.provenance, /cop(ied|y)/i)
  assert.match(tail.provenance, /not\b[^.]*\b(this chat|new profile)/i, 'it says the replies belong to the source, not the new chat')
  h.dispose()
})

test('the copy keeps the last 20 visible messages and marks the omission instead of trimming silently', async () => {
  const rows = []
  for (let index = 1; index <= 25; index += 1) rows.push(user(`message ${index}`))

  const h = await standard({ history: () => ({ count: rows.length, messages: rows }) })
  const { readTail, TAIL_MESSAGE_LIMIT } = h.namespace.handoff
  const tail = await readTail(h.sdk.host, SOURCE, 'rt-src')

  assert.equal(TAIL_MESSAGE_LIMIT, 20)
  assert.equal(tail.messages.length, 20)
  assert.equal(tail.messages[0].text, 'message 6', 'the window is the last 20, not the first')
  assert.equal(tail.messages[19].text, 'message 25')
  assert.equal(tail.omitted, 5)
  assert.match(tail.provenance, /Copy cap/)
  assert.match(tail.provenance, /20/, 'the cap note names the message limit')
  h.dispose()
})

test('the named character cap drops what does not fit and says so', async () => {
  const probe = await standard()
  const { TAIL_CHAR_BUDGET } = probe.namespace.handoff
  probe.dispose()

  assert.equal(typeof TAIL_CHAR_BUDGET, 'number')
  assert.ok(TAIL_CHAR_BUDGET >= 2000 && TAIL_CHAR_BUDGET <= 40000, 'the cap is a named, bounded heuristic')

  const h = await standard({
    history: () => ({ count: 2, messages: [user('a'.repeat(TAIL_CHAR_BUDGET)), assistant('the newest reply')] })
  })
  const tail = await h.namespace.handoff.readTail(h.sdk.host, SOURCE, 'rt-src')

  assert.equal(tail.messages.length, 1, 'only what fits the budget is kept')
  assert.equal(tail.messages[0].text, 'the newest reply', 'the newest message survives')
  assert.equal(tail.omitted, 1)
  assert.match(tail.provenance, /Copy cap/)
  assert.match(tail.provenance, new RegExp(String(TAIL_CHAR_BUDGET)), 'the cap note names the character budget')
  h.dispose()
})

test('a single oversized newest message is shortened rather than dropped', async () => {
  const probe = await standard()
  const { TAIL_CHAR_BUDGET } = probe.namespace.handoff
  probe.dispose()

  const h = await standard({ history: () => ({ count: 1, messages: [user('b'.repeat(TAIL_CHAR_BUDGET * 2))] }) })
  const tail = await h.namespace.handoff.readTail(h.sdk.host, SOURCE, 'rt-src')

  assert.equal(tail.messages.length, 1)
  assert.equal(tail.clipped, true)
  assert.equal(tail.messages[0].text.length, TAIL_CHAR_BUDGET)
  assert.match(tail.provenance, /shortened/, 'the shortening is stated, not silent')
  h.dispose()
})

test('an empty or unreadable history is reported, never silently seeded', async () => {
  const empty = await standard({ history: () => ({ count: 0, messages: [] }) })
  const emptyTail = await empty.namespace.handoff.readTail(empty.sdk.host, SOURCE, 'rt-src')
  assert.equal(emptyTail.ok, true)
  assert.deepEqual(plain(emptyTail.messages), [])
  assert.deepEqual(plain(empty.namespace.handoff.buildContextSeed(emptyTail)), { messages: [] })
  empty.dispose()

  const broken = await standard({ history: () => { throw new Error('history offline') } })
  const brokenTail = await broken.namespace.handoff.readTail(broken.sdk.host, SOURCE, 'rt-src')
  assert.equal(brokenTail.ok, false)
  assert.equal(brokenTail.code, 'history-unreadable')
  broken.dispose()
})

// ── the seed builders ──────────────────────────────────────────────────────

test('the context seed is the provenance row followed by the copied turns, in order', async () => {
  const h = await standard({
    history: () => ({ count: 3, messages: [user('q1'), assistant('a1'), user('q2')] })
  })
  const { readTail, buildContextSeed } = h.namespace.handoff
  const tail = await readTail(h.sdk.host, SOURCE, 'rt-src')
  const seed = buildContextSeed(tail)

  assert.deepEqual(plain(seed.messages.map(row => row.role)), ['system', 'user', 'assistant', 'user'])
  assert.equal(seed.messages[0].content, tail.provenance)
  assert.deepEqual(plain(seed.messages.slice(1)), [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ])
  for (const row of seed.messages) {
    assert.equal(row.display_kind, undefined, 'no seeded row carries a display_kind')
  }
  h.dispose()
})

test('the brief is assembled locally: no host, no model and a bounded excerpt window', async () => {
  const h = await standard({
    history: () => ({
      count: 4,
      messages: [user('how do I deploy?'), assistant('run the script'), user('and roll back?'), assistant('revert the tag')]
    })
  })
  const { readTail, buildBrief, BRIEF_EXCERPT_LIMIT, BRIEF_EXCERPT_CHARS } = h.namespace.handoff
  const tail = await readTail(h.sdk.host, SOURCE, 'rt-src')

  // Called with plain data only: an implementation touching a host would throw here.
  const source = { profile: 'default', connectionId: 'local', storedId: 'src-1', cwd: CWD, projectId: 'p-demo', title: 'Demo work' }
  const brief = buildBrief({ source, tail })
  const body = brief.messages.map(row => row.content).join('\n')

  assert.deepEqual(plain(brief.messages.map(row => row.role)), ['user'], 'the brief is one opening turn')
  assert.match(body, /default/)
  assert.match(body, /src-1/, 'the source session id is named')
  assert.ok(body.includes(CWD), 'the inherited project folder is named')
  assert.match(body, /p-demo/, 'the project identity is named')
  assert.match(body, /Demo work/, 'the title is used as the topic when one exists')
  assert.match(body, /how do I deploy\?/, 'recent messages are excerpted')
  assert.match(body, /not a model|no model/i, 'the brief says it is extractive')
  assert.ok(typeof BRIEF_EXCERPT_LIMIT === 'number' && BRIEF_EXCERPT_LIMIT > 0 && BRIEF_EXCERPT_LIMIT <= 20)
  assert.ok(typeof BRIEF_EXCERPT_CHARS === 'number' && BRIEF_EXCERPT_CHARS >= 80)

  const long = Array.from({ length: 30 }, (_, index) => user(`turn ${index + 1} ${'x'.repeat(500)}`))
  const many = await standard({ history: () => ({ count: long.length, messages: long }) })
  const longTail = await many.namespace.handoff.readTail(many.sdk.host, SOURCE, 'rt-src')
  const longBody = buildBrief({ source: { ...source, title: '' }, tail: longTail }).messages[0].content

  assert.match(longBody, /turn 30/, 'the newest turn is the one kept')
  assert.ok(longBody.split('\n').length <= BRIEF_EXCERPT_LIMIT + 8, 'the brief window is bounded')
  assert.ok(!longBody.includes('x'.repeat(BRIEF_EXCERPT_CHARS + 1)), 'a single excerpt is capped')
  assert.match(longBody, /Topic: /, 'a topic line is always present')

  many.dispose()
  h.dispose()
})

// ── the dialog and its wiring ──────────────────────────────────────────────

const COPY = 'Copy context'
const BRIEF = 'Brief handoff'
const FRESH = 'Start fresh'
const CANCEL = 'Cancel'

/** Select a row, then let the real menu close the way Radix does on select. */
const openDialog = async (h, profile = 'coder') => {
  await h.open()
  const item = h.items().find(node => h.text(node).includes(profile))
  assert.ok(item, `the ${profile} row must be offered`)
  h.select(item)

  for (let round = 0; round < 4; round += 1) await h.settle()

  const menu = h.find('DropdownMenu')

  if (menu) {
    menu.props.onOpenChange(false)
    h.render()
  }

  return item
}
const act = async (h, label, rounds = 6) => {
  h.dialogAction(label).props.onClick()

  for (let round = 0; round < rounds; round += 1) await h.settle()
}
const rpcMethods = h => h.rpcCalls.map(call => call.method)

test('the dialog appears only for a different confirmed profile, outside the menu, with three actions and Cancel', async () => {
  const h = await standard()
  assert.equal(h.dialogOpen(), false, 'nothing is shown before a profile is chosen')
  await openDialog(h)

  assert.equal(h.dialogOpen(), true)
  assert.equal(h.text(h.find('DialogTitle')), 'Continue with coder?')
  assert.ok(h.find('DialogContent'), 'the dialog uses the public SDK Dialog primitives')
  assert.ok(h.find('DialogFooter'))

  const labels = h.nodes().filter(node => node.type === 'sdk.Button').map(node => h.text(node))
  for (const label of [COPY, BRIEF, FRESH, CANCEL]) {
    assert.ok(labels.includes(label), `the dialog must offer "${label}"`)
  }
  assert.equal(h.find('DropdownMenuContent') && h.within(h.find('DropdownMenuContent'), 'Dialog'), undefined,
    'the dialog must not live inside the menu content')
  assert.equal(h.nodes().find(node => node.type === 'sdk.Dialog').key, 'dialog', 'the dialog is a sibling of the menu')
  assert.equal(h.creates.length, 0, 'opening the dialog writes nothing')
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.notices, [])
  h.dispose()
})

test('no dialog for the same profile as the focused chat: the previous handoff runs unchanged', async () => {
  const h = await standard({
    sessions: r => (r.profile === 'default' ? [sourceRow, { ...newRow, profile: 'default' }] : [newRow])
  })
  await choose(h, 'Default', 'fresh')

  assert.equal(h.dialogOpen(), false, 'the chat already belongs to that profile')
  assert.equal(h.creates.length, 1, 'the same-profile pick still inherits the project')
  assert.equal(h.creates[0].route.profile, 'default')
  assert.equal(h.creates[0].params.cwd, CWD)
  assert.ok(!('messages' in h.creates[0].params), 'no variant was chosen, so nothing is seeded')
  assert.equal(h.opens.length, 1)
  assert.equal(h.histories.length, 0, 'no dialog means no variant and no history read')
  assert.deepEqual(h.notices, [])
  h.dispose()
})

test('no dialog for a fresh draft or an unresolved owner: the plain new chat stays', async () => {
  for (const focus of [focusState(null, null), focusState(null, 'src-1'), focusState({}, 'src-1'), focusState({ connectionId: 'local', profile: '  ' }, 'src-1')]) {
    const h = await harness({
      routes: [SOURCE, TARGET],
      focus,
      sessions: () => [sourceRow],
      projects: () => [named({ sessionIds: ['src-1'] })],
      history: () => ({ count: 0, messages: [] })
    })
    await choose(h, 'coder', 'fresh')
    assert.equal(h.dialogOpen(), false)
    assert.equal(h.calls.length, 1, 'the honest new-chat path is kept')
    assert.deepEqual(plain(h.calls[0][0]), TARGET)
    assert.equal(h.histories.length, 0)
    h.dispose()
  }
})

test('Cancel and Escape create nothing and report nothing', async () => {
  for (const stop of ['cancel', 'dismiss']) {
    const h = await standard()
    await openDialog(h)
    assert.equal(h.dialogOpen(), true)

    if (stop === 'cancel') await act(h, CANCEL)
    else { h.dismissDialog(); await h.settle() }

    assert.equal(h.dialogOpen(), false, 'the dialog closes')
    assert.equal(h.creates.length, 0)
    assert.equal(h.opens.length, 0)
    assert.deepEqual(h.calls, [], 'Cancel never falls back to a plain new chat')
    assert.deepEqual(h.notices, [], 'Cancel is not an error')
    assert.equal(h.rpcCalls.length, 0, 'Cancel issues no RPC at all')
    assert.equal(h.histories.length, 0)
    h.dispose()
  }
})

test('Copy context seeds the create with the copied tail and asks the open for history', async () => {
  const h = await standard({
    history: () => ({ count: 4, messages: [user('q1'), assistant('a1'), NOISE[0], user('q2')] }),
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, message_count: 4 }])
  })
  await openDialog(h)
  await act(h, COPY)

  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 1)
  const seed = plain(h.creates[0].params.messages)
  assert.deepEqual(seed.map(row => row.role), ['system', 'user', 'assistant', 'user'])
  assert.match(seed[0].content, /copied/i)
  assert.deepEqual(seed.slice(1), [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ], 'hidden scaffolding is not copied')
  assert.equal(h.opens[0].options.expectHistory, true)
  assert.equal(h.titles.length, 0, 'a seeded create needs no title materialisation')
  assert.deepEqual(h.notices, [])

  assert.deepEqual([...new Set(rpcMethods(h))].sort(), ['projects.tree', 'session.create', 'session.history'],
    'only readonly reads and the one create: no prompt.submit, no steer, no model call')
  assert.ok(!rpcMethods(h).includes('prompt.submit') && !rpcMethods(h).includes('prompt.steer'))
  assert.ok(h.creates.every(call => call.route.profile === 'coder'), 'the source session is never written')
  assert.equal(h.titles.length, 0)
  assert.equal(h.histories.length, 1)
  assert.equal(h.histories[0].route.profile, 'default', 'the history is read from the source route')
  assert.equal(h.histories[0].params.session_id, 'rt-src', 'and from the focused runtime session')
  h.dispose()
})

test('Copy context names its cap when the tail is truncated', async () => {
  const many = Array.from({ length: 24 }, (_, index) => user(`t${index + 1}`))
  const h = await standard({
    history: () => ({ count: many.length, messages: many }),
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, message_count: 21 }])
  })
  await openDialog(h)
  await act(h, COPY)

  const seed = plain(h.creates[0].params.messages)
  assert.equal(seed.length, 21, 'the provenance row plus the last 20 turns')
  assert.match(seed[0].content, /Copy cap/)
  assert.equal(seed[1].content, 't5', 'the window is the tail')
  assert.equal(seed[20].content, 't24')
  h.dispose()
})

test('Copy context refuses to open anything when the history cannot be read', async () => {
  const h = await standard({ history: () => { throw new Error('history offline') } })
  await openDialog(h)
  await act(h, COPY)

  assert.equal(h.creates.length, 0, 'an unreadable history is a visible refusal before any write')
  assert.equal(h.opens.length, 0)
  assert.deepEqual(h.calls, [])
  assert.ok(messages(h).some(message => /history could not be read/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('Copy context still opens the chat when the source has no visible words, and says so', async () => {
  const h = await standard({ history: () => ({ count: 1, messages: [NOISE[2]] }) })
  await openDialog(h)
  await act(h, COPY)

  assert.equal(h.creates.length, 1)
  assert.ok(!('messages' in h.creates[0].params), 'an empty copy seeds no messages')
  assert.equal(h.titles.length, 1, 'the unseeded create is materialised as usual')
  assert.ok(messages(h).some(message => /no visible messages/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('Brief handoff seeds one locally assembled brief row with the source identity and excerpts', async () => {
  const h = await standard({
    history: () => ({ count: 3, messages: [user('how do we deploy?'), assistant('run the script'), user('and roll back?')] }),
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, message_count: 1 }])
  })
  await openDialog(h)
  await act(h, BRIEF)

  assert.equal(h.creates.length, 1)
  const seed = plain(h.creates[0].params.messages)
  assert.equal(seed.length, 1)
  assert.equal(seed[0].role, 'user')
  assert.match(seed[0].content, /Handoff brief/)
  assert.match(seed[0].content, /no model/i)
  assert.match(seed[0].content, /Source: default \(local, session src-1\)/)
  assert.match(seed[0].content, new RegExp(CWD.replace(/[/\\]/g, '\\$&')))
  assert.match(seed[0].content, /p-demo/)
  assert.match(seed[0].content, /how do we deploy\?/)
  assert.equal(h.opens[0].options.expectHistory, true)
  assert.deepEqual([...new Set(rpcMethods(h))].sort(), ['projects.tree', 'session.create', 'session.history'],
    'the brief is built locally: no model RPC, no submit')
  h.dispose()
})

test('Start fresh creates an unseeded chat, materialises its own title and expects no history', async () => {
  const h = await standard({ history: () => { throw new Error('must not be read') } })
  await openDialog(h)
  await act(h, FRESH)

  assert.equal(h.creates.length, 1)
  assert.ok(!('messages' in h.creates[0].params), 'Start fresh seeds nothing')
  assert.equal(h.titles.length, 1)
  assert.equal(h.titles[0].params.session_id, 'rt-new', 'the title targets our own new runtime id')
  assert.equal(h.titles[0].params.title, h.creates[0].params.title)
  assert.equal(h.titles[0].route.profile, 'coder')
  assert.equal(h.opens.length, 1)
  assert.equal(h.opens[0].storedId, 'new-1')
  assert.equal(h.opens[0].options.expectHistory, false)
  assert.equal(h.histories.length, 0, 'Start fresh reads no history')
  assert.deepEqual(h.notices, [])
  h.dispose()
})

test('each dialog action mints its own idempotency key', async () => {
  const h = await standard({
    history: () => ({ count: 1, messages: [user('q1')] }),
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, message_count: 2 }])
  })
  await openDialog(h)
  await act(h, COPY)
  await openDialog(h)
  await act(h, FRESH)

  assert.equal(h.creates.length, 2)
  assert.notEqual(h.creates[0].params.idempotency_key, h.creates[1].params.idempotency_key)
  h.dispose()
})

test('a second action click while one is in flight never creates twice', async () => {
  const gate = deferred()
  const h = await standard({ create: () => gate.promise.then(() => ({ ...created })) })
  await openDialog(h)
  h.dialogAction(FRESH).props.onClick()
  h.dialogAction(FRESH).props.onClick()
  await h.settle()
  assert.equal(h.creates.length, 0, 'the create has not settled yet')
  gate.resolve()

  for (let round = 0; round < 6; round += 1) await h.settle()

  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 1)
  h.dispose()
})

test('a source change between opening the dialog and choosing an action is refused before any write', async () => {
  const gate = deferred()
  const h = await standard({
    projects: r => (r.profile === 'default' ? gate.promise.then(() => [named({ sessionIds: ['src-1'] })]) : Promise.resolve([named()]))
  })
  await openDialog(h)
  h.dialogAction(FRESH).props.onClick()
  await h.settle()
  h.focus.storedId('src-other')
  gate.resolve()

  for (let round = 0; round < 6; round += 1) await h.settle()

  assert.equal(h.creates.length, 0)
  assert.equal(h.opens.length, 0)
  assert.ok(messages(h).some(message => /changed while/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('an action refuses a route that vanished while the dialog was open, and re-reads the list once', async () => {
  const h = await standard()
  await openDialog(h)
  const before = h.reads
  h.reader(async () => [SOURCE])
  await act(h, FRESH)

  assert.equal(h.creates.length, 0)
  assert.deepEqual(h.calls, [])
  assert.equal(h.reads, before + 1, 'the action revalidates the route list exactly once')
  assert.ok(messages(h).some(message => /no longer available/i.test(message)))
  h.dispose()
})

test('disposal while the dialog is open opens nothing, and a late create is still dropped', async () => {
  const gate = deferred()
  const h = await standard({ create: () => gate.promise.then(() => ({ ...created })) })
  await openDialog(h)
  h.dispose()
  await h.settle()
  assert.equal(h.creates.length, 0, 'a disposed picker accepts no action')

  const live = await standard({ create: () => gate.promise.then(() => ({ ...created })) })
  await openDialog(live)
  live.dialogAction(FRESH).props.onClick()
  for (let round = 0; round < 3; round += 1) await live.settle()
  assert.equal(live.creates.length, 1)
  live.unmount()
  gate.resolve()

  for (let round = 0; round < 6; round += 1) await live.settle()

  assert.equal(live.titles.length, 0, 'nothing after an abandoned create is issued')
  assert.equal(live.opens.length, 0, 'an abandoned handoff never opens a chat')
  assert.deepEqual(live.notices, [], 'a user-initiated stop is not an error')
})

// ── stage-1 softenings ─────────────────────────────────────────────────────

const BETA = route('beta', 'coder')

test('a profile on another gateway opens the chat without the project, and says so', async () => {
  const h = await standard({
    routes: [SOURCE, BETA],
    history: () => ({ count: 2, messages: [user('q1'), assistant('a1')] }),
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, cwd: '', message_count: 3 }])
  })
  await openDialog(h)
  await act(h, COPY)

  assert.equal(h.creates.length, 1, 'a different gateway is not a refusal')
  const params = h.creates[0].params
  assert.equal(h.creates[0].route.connectionId, 'beta')
  assert.ok(!('cwd' in params) && !('cwd_explicit' in params), 'no folder is invented for another gateway')
  assert.equal(params.source, 'desktop')
  assert.deepEqual(plain(params.messages).map(row => row.role), ['system', 'user', 'assistant'])
  assert.equal(h.opens.length, 1)
  assert.equal(h.opens[0].options.expectHistory, true)
  assert.deepEqual(h.calls, [], 'the softening never falls back to a plain new chat')
  assert.equal(h.treeCalls.length, 0, 'no project evidence is read or fabricated')
  assert.equal(h.histories.length, 1, 'the copied context still comes from the focused chat')
  assert.ok(messages(h).some(message => /different source/i.test(message) && /without the inherited project/i.test(message)),
    JSON.stringify(messages(h)))
  h.dispose()
})

test('a profile on another gateway also opens for Start fresh, unseeded and titled', async () => {
  const h = await standard({
    routes: [SOURCE, BETA],
    history: () => { throw new Error('must not be read') },
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, cwd: '', message_count: 0 }])
  })
  await openDialog(h)
  await act(h, FRESH)

  assert.equal(h.creates.length, 1)
  assert.ok(!('cwd' in h.creates[0].params))
  assert.equal(h.titles.length, 1)
  assert.equal(h.opens.length, 1)
  assert.equal(h.opens[0].options.expectHistory, false)
  assert.equal(h.histories.length, 0)
  assert.ok(messages(h).some(message => /different source/i.test(message)), JSON.stringify(messages(h)))
  h.dispose()
})

test('a folder that only has an automatic group on the source still inherits its cwd', async () => {
  const h = await standard({
    projects: r => [r.profile === 'default' ? auto({ sessionIds: ['src-1'] }) : named()],
    sessions: r => (r.profile === 'default' ? [sourceRow] : [{ ...newRow, message_count: 0 }])
  })
  await openDialog(h)
  await act(h, FRESH)

  assert.equal(h.creates.length, 1, 'an auto group is an acceptable source context')
  assert.equal(h.creates[0].params.cwd, CWD)
  assert.equal(h.creates[0].params.cwd_explicit, true)
  assert.equal(h.opens.length, 1)
  assert.deepEqual(h.notices, [])
  h.dispose()
})

test('the auto-group softening keeps every other source refusal', async () => {
  const cases = [
    {
      name: 'a multi-folder auto group',
      node: { ...auto({ sessionIds: ['src-1'] }), repos: [...auto().repos, { id: '/other', path: '/other', groups: [trunkLane('/other')] }] },
      text: /more than one folder/i
    },
    {
      name: 'an auto group whose lane is a worktree',
      node: auto({ sessionIds: ['src-1'], groups: undefined }),
      override: node => ({ ...node, repos: [{ ...node.repos[0], groups: [{ ...trunkLane(`${CWD}/.worktrees/task`), isMain: false }] }] }),
      text: /project structure could not be confirmed/i
    }
  ]

  for (const { name, node, override, text } of cases) {
    const source = override ? override(node) : node
    const h = await standard({ projects: r => [r.profile === 'default' ? source : named()] })
    await choose(h)
    assert.ok(messages(h).some(message => text.test(message)), `${name}: expected ${text}, got ${JSON.stringify(messages(h))}`)
    assert.equal(h.creates.length, 0, `${name} is still refused before any write`)
    assert.equal(h.opens.length, 0)
    h.dispose()
  }
})
