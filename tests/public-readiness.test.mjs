// Actual plugin entry, synthetic gateway only; never a live session or Electron test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, route, focusState, deferred } from './harness.mjs'

const SOURCE = route('local', 'default')
const TARGET = route('local', 'coder')
const CWD = '/synthetic/demo'
const sourceRow = { id: 'src', profile: 'default', cwd: CWD, message_count: 1, title: 'Source unchanged' }
const project = ids => ({
  id: 'project', path: CWD, sessionIds: ids,
  repos: [{ path: CWD, sessionCount: ids.length, groups: [{ path: CWD, isMain: true, isKanban: false }] }]
})
const plain = value => JSON.parse(JSON.stringify(value))
const settle = async h => { for (let i = 0; i < 8; i++) await h.settle() }
async function pick(h, target = TARGET, action = 'Start fresh') {
  await h.open()
  const item = h.items().find(item => item.key === `${target.connectionId}\u0000${target.profile}`)
  assert.ok(item)
  h.select(item)
  await settle(h)
  if (h.dialogOpen()) { h.dialogAction(action).props.onClick(); await settle(h) }
}
function gateway() {
  const cache = new Map(), rows = new Map(), titles = new Map([['rt-src', sourceRow.title]])
  return {
    cache, rows, titles,
    create(r, p) {
      // Native cache is keyed by caller key alone, not profile or payload.
      if (cache.has(p.idempotency_key)) return cache.get(p.idempotency_key)
      const n = cache.size + 1
      const ids = { session_id: `rt-${n}`, stored_session_id: `stored-${n}` }
      cache.set(p.idempotency_key, ids)
      rows.set(ids.stored_session_id, { id: ids.stored_session_id, profile: r.targetProfile, cwd: p.cwd ?? '', message_count: p.messages?.length ?? 0 })
      titles.set(ids.session_id, p.title)
      return ids
    },
    title(_r, p) { titles.set(p.session_id, p.title); return {} },
    sessions(r) { return [sourceRow, ...[...rows.values()].filter(row => row.profile === r.targetProfile)] }
  }
}
async function standard(overrides = {}, g = gateway()) {
  return harness({
    routes: [SOURCE, TARGET], focus: focusState({ connectionId: 'local', profile: 'default' }, 'src', 'rt-src'),
    projects: () => [project(['src'])], sessions: g.sessions,
    create: g.create, title: g.title, history: () => ({ messages: [{ role: 'user', text: 'question' }] }),
    openSession: async () => {}, ...overrides
  })
}

test('keys: registrations and VM windows sharing native cache never reuse old sessions or titles', async () => {
  const g = gateway(), ids = [], keys = []
  const a = await standard({}, g)
  await pick(a)
  ids.push(a.opens.at(-1).storedId); keys.push(a.creates.at(-1).params.idempotency_key)
  g.titles.set('rt-1', 'Old title must stay')
  a.registerAgain()
  await pick(a, SOURCE)
  ids.push(a.opens.at(-1).storedId); keys.push(a.creates.at(-1).params.idempotency_key)
  const b = await standard({}, g)
  await pick(b)
  ids.push(b.opens.at(-1).storedId); keys.push(b.creates.at(-1).params.idempotency_key)
  assert.equal(new Set(keys).size, 3, 'each logical create must have a collision-resistant lifetime-independent key')
  assert.equal(new Set(ids).size, 3, 'a new click must not open an old cached session')
  assert.equal(g.titles.get('rt-1'), 'Old title must stay')
  assert.equal(g.titles.get('rt-src'), 'Source unchanged')
  assert.equal(a.creates.length + b.creates.length, 3)
  a.dispose(); b.dispose()
})

for (const crypto of [null, {}, { getRandomValues() { throw Error('entropy unavailable') } }]) {
  test(`keys: missing/broken Web Crypto refuses create safely (${String(crypto)})`, async () => {
    const h = await standard({ crypto })
    await pick(h)
    assert.equal(h.creates.length, 0, 'no create without cryptographic entropy')
    assert.equal(h.titles.length, 0)
    assert.equal(h.opens.length, 0)
    assert.match(h.notices.map(n => n.message).join(' '), /secure|crypto/i)
    // The pending lock is released even on the explicit refusal.
    await pick(h, SOURCE)
    assert.equal(h.creates.length, 0)
    h.dispose()
  })
}

for (const path of ['dialog', 'sibling']) {
  for (const stage of ['history', 'create', 'title', 'readback', 'open']) {
    if (path === 'sibling' && stage === 'history') continue
    test(`focus: ${path} drift during ${stage} stops subsequent writes/navigation and releases pending`, async () => {
      const gate = deferred(), entered = deferred(), g = gateway()
      let blocked = true
      const hold = async value => { if (blocked) { entered.resolve(); await gate.promise } return value }
      const target = path === 'sibling' ? SOURCE : TARGET
      const h = await standard({
        history: async () => hold({ messages: [{ role: 'user', text: 'question' }] }),
        create: async (r, p) => stage === 'create' ? hold(g.create(r, p)) : g.create(r, p),
        title: async (r, p) => stage === 'title' ? hold(g.title(r, p)) : g.title(r, p),
        sessions: async r => {
          const rows = g.sessions(r)
          return stage === 'readback' && g.cache.size ? hold(rows) : rows
        },
        openSession: async () => { if (stage === 'open' && blocked) { await hold(); throw Error('open failed') } }
      }, g)
      await pick(h, target, stage === 'history' ? 'Copy context' : 'Start fresh')
      await entered.promise
      assert.equal(h.creates.length, stage === 'history' ? 0 : 1)
      h.focus.storedId('other')
      // Returning to the old source cannot revive the in-flight intent.
      h.focus.storedId('src')
      blocked = false; gate.resolve(); await settle(h)
      assert.equal(h.titles.length, ['history', 'create'].includes(stage) ? 0 : 1, 'drift must stop the next write')
      // For `open` this asserts the RETRY is suppressed. The first host.openSession
      // call was already accepted by the SDK and this watcher cannot cancel its own
      // internal late navigation — only further calls from here on.
      assert.equal(h.opens.length, stage === 'open' ? 1 : 0, 'drift must stop late navigation/open retry')
      assert.equal(g.titles.get('rt-src'), sourceRow.title)
      const before = h.creates.length
      await pick(h, target)
      assert.equal(h.creates.length, before + 1, 'a new conscious click is allowed after drift')
      h.dispose()
    })
  }
}

test('focus: own successful navigation is success, not focus failure', async () => {
  let h
  h = await standard({ openSession: async () => { h.focus.storedId('stored-1'); h.focus.runtime('rt-1'); h.focus.owner({ connectionId: 'local', profile: 'coder' }) } })
  await pick(h)
  assert.equal(h.opens.length, 1)
  assert.deepEqual(h.notices, [])
  h.dispose()
})

const recoveryButton = h => h.nodes().find(node => node.type === 'sdk.Button' && /^Open created chat/.test(h.text(node)))

test('focus: drift releases pending before a suspended history resolves', async () => {
  const gate = deferred()
  const h = await standard({ history: () => gate.promise })
  await pick(h, TARGET, 'Copy context')
  assert.equal(h.histories.length, 1)
  h.focus.runtime('rt-other')
  await pick(h, TARGET, 'Start fresh')
  assert.equal(h.creates.length, 1, 'new conscious action need not wait for stale RPC timeout')
  gate.resolve({ messages: [{ role: 'user', text: 'late question' }] }); await settle(h)
  assert.equal(h.creates.length, 1, 'old history must not create after the new action')
  h.dispose()
})

test('focus: dispose cleans pending source subscriptions without waiting for RPC resolution', async () => {
  const gate = deferred()
  const h = await standard({ history: () => gate.promise })
  await pick(h, TARGET, 'Copy context')
  h.dispose()
  assert.equal(h.focus.subscriptions(), 0, 'dispose must release in-flight watchers immediately')
  gate.resolve({ messages: [] }); await settle(h)
  assert.equal(h.creates.length, 0)
})


// Synthetic outputs of the native projection. `_coerce_message_text` joins a
// leading "\n" before a media part and then concatenates the next text part with
// NO separator, so the caption can start right after the payload.
// No actual files, images, user histories or credentials are read.
// A recognised media payload/directive must never reach either variant. Ordinary
// HTTP links — including image-file URLs — are preserved per D22, so they are not
// part of this pattern; only the typed media URL of the structured fixtures is.
const MEDIA_LEAK = /@image:|data:image|\[image\]|\[audio\]|\[screenshot\]|\[structured content\]|input_image|example\.test\/opaque/
const attachmentFixtures = [
  ['native refs only', { text: '@image:/synthetic/one.png\n@image:`C:\\synthetic path\\two.png`' }, ''],
  ['native refs glued to the following caption', { text: 'Caption first\n@image:"/synthetic/path with spaces.png"Caption last' }, 'Caption first\nCaption last'],
  ['padded data URI only', { text: '\ndata:image/png;base64,QUJDRA==' }, ''],
  ['padded data URI glued to the following caption', { text: 'Before\ndata:image/png;base64,QUJDRA==Caption last' }, 'Before\nCaption last'],
  ['audio placeholder glued to the following caption', { text: 'Before\n[audio]Caption last' }, 'Before\nCaption last'],
  ['image placeholder glued to the following caption', { text: '[image]Caption last' }, 'Caption last'],
  ['media placeholders only', { text: '[image]\n[audio]\n[screenshot]\n[structured content]' }, ''],
  ['unpadded data URI ending a line', { text: 'Caption first\ndata:image/png;base64,QUJDRAAB' }, 'Caption first'],
  ['unpadded data URI only', { text: 'data:image/png;base64,QUJDRAAB' }, ''],
  {
    name: 'unpadded data URI glued to the caption keeps the unrecoverable text',
    row: { text: 'Caption first\ndata:image/png;base64,QUJDRAABCCaption last' },
    copy: 'Caption first\ndata:image/png;base64,QUJDRAABCCaption last',
    limitation: true
  },
  ['ordinary standalone image-file link', { text: 'https://images.example.test/photo.png?size=large' }, 'https://images.example.test/photo.png?size=large'],
  ['ordinary image-file link in prose', { text: 'Reference https://example.test/diagram.png is useful\nCaption last' }, 'Reference https://example.test/diagram.png is useful\nCaption last'],
  ['ordinary HTTP links', { text: 'Read https://example.test/docs?q=one\nhttps://example.test/guide\nCaption last' }, 'Read https://example.test/docs?q=one\nhttps://example.test/guide\nCaption last'],
  ['legacy image hint and placeholder line', { text: 'Caption first\n\n[Image attached at: /synthetic/one.png]\n[screenshot]\nCaption last' }, 'Caption first\n\n\n\nCaption last'],
  ['inline directive', { text: 'Before @image:`/synthetic/a b.png` after' }, 'Before  after'],
  ['typed image-only part', { content: { type: 'image_url', image_url: { url: 'https://example.test/opaque' } }, text: 'https://example.test/opaque' }, ''],
  ['typed parts', { content: [{ type: 'input_text', text: 'Caption first' }, { type: 'input_image', image_url: 'https://example.test/opaque' }, { type: 'output_text', text: 'Caption last' }], text: 'Caption first\nhttps://example.test/opaqueCaption last' }, 'Caption first Caption last']
].map(entry => (Array.isArray(entry) ? { name: entry[0], row: entry[1], copy: entry[2] } : entry))
for (const action of ['Copy context', 'Brief handoff']) {
  for (const { name, row, copy, limitation } of attachmentFixtures) {
    test(`attachments: ${action} handles ${name} without eating captions or ordinary links`, async () => {
      const h = await standard({ history: () => ({ messages: [{ role: 'user', ...row }] }) })
      await pick(h, TARGET, action)
      assert.equal(h.creates.length, 1)
      const seed = plain(h.creates[0].params.messages ?? [])
      if (action === 'Copy context') {
        assert.deepEqual(seed.slice(1), copy ? [{ role: 'user', content: copy }] : [], `copy keeps authored text and drops recognised media only; got ${JSON.stringify(plain(seed.slice(1)))}`)
        if (!copy) assert.equal(seed.length, 0, 'attachment-only Copy is an empty seed')
      } else {
        const body = seed[0].content
        if (!limitation) assert.ok(!MEDIA_LEAK.test(body), `brief must not quote a recognised media payload or directive; got ${JSON.stringify(body)}`)
        if (copy) assert.ok(body.includes(copy.replace(/\s+/g, ' ')), `brief keeps the caption and ordinary links; got ${JSON.stringify(body)}`)
        else assert.ok(!/user:/.test(body), 'an attachment-only row must not become a brief excerpt')
      }
      h.dispose()
    })
  }
}

test('recovery: explicit action opens the exact known chat without create/title/history again', async () => {
  let fails = true
  const h = await standard({ openSession: async () => { if (fails) throw Error('hydrate failed') } })
  await pick(h, TARGET, 'Copy context')
  assert.equal(h.opens.length, 2)
  assert.ok(recoveryButton(h), 'known created chat must remain explicitly recoverable')
  const original = plain(h.opens[0]), counts = [h.creates.length, h.titles.length, h.histories.length]
  recoveryButton(h).props.onClick(); await settle(h)
  assert.ok(recoveryButton(h), 'repeated failure must retain the exact recovery')
  fails = false
  recoveryButton(h).props.onClick(); await settle(h)
  assert.deepEqual(plain(h.opens.at(-1)), original)
  assert.deepEqual([h.creates.length, h.titles.length, h.histories.length], counts)
  assert.equal(recoveryButton(h), undefined, 'successful recovery is cleared')
  h.dispose()
})

for (const change of ['removed', 'remapped', 'ambiguous', 'offline']) {
  test(`recovery: ${change} route never falls back or re-creates`, async () => {
    const h = await standard({ openSession: async () => { throw Error('open failed') } })
    await pick(h)
    assert.ok(recoveryButton(h))
    h.reader(async () => {
      if (change === 'offline') throw Error('offline')
      return change === 'removed' ? [SOURCE] : [SOURCE, ...(change === 'ambiguous' ? [TARGET, TARGET] : [{ ...TARGET, targetProfile: 'other' }])]
    })
    recoveryButton(h).props.onClick(); await settle(h)
    assert.equal(h.opens.length, 2)
    assert.equal(h.creates.length, 1)
    assert.equal(h.calls.length, 0)
    assert.ok(recoveryButton(h), 'failed revalidation keeps recovery for a later explicit attempt')
    h.dispose()
  })
}

for (const stage of ['readback', 'title', 'unknown']) {
  test(`recovery: ${stage} outcome distinguishes known IDs from unknown create`, async () => {
    const g = gateway()
    let fails = true
    const h = await standard({
      create: (r, p) => { if (stage === 'unknown') throw Error('lost create response'); return g.create(r, p) },
      title: (r, p) => { if (stage === 'title' && fails) throw Error('lost title response'); return g.title(r, p) },
      sessions: r => { if (stage === 'readback' && fails && g.cache.size) throw Error('readback offline'); return g.sessions(r) }
    }, g)
    await pick(h)
    assert.equal(Boolean(recoveryButton(h)), stage !== 'unknown')
    if (stage !== 'unknown') {
      const counts = [h.creates.length, h.titles.length, h.histories.length]
      fails = false
      recoveryButton(h).props.onClick(); await settle(h)
      assert.equal(h.opens.at(-1).storedId, 'stored-1')
      assert.deepEqual([h.creates.length, h.titles.length, h.histories.length], counts)
    }
    h.dispose()
  })
}

for (const stop of ['drift', 'dispose']) {
  test(`recovery: ${stop} during revalidation prevents late opening`, async () => {
    const h = await standard({ openSession: async () => { throw Error('open failed') } })
    await pick(h)
    assert.ok(recoveryButton(h))
    const gate = deferred()
    h.reader(() => gate.promise)
    recoveryButton(h).props.onClick(); await h.settle()
    if (stop === 'dispose') h.dispose()
    else h.focus.runtime('other')
    gate.resolve([SOURCE, TARGET]); await settle(h)
    assert.equal(h.opens.length, 2)
    assert.equal(h.creates.length, 1)
    if (stop !== 'dispose') { assert.ok(recoveryButton(h)); h.dispose() }
  })
}

// Documented limit of the flatten projection — NOT a guarantee that no words are
// ever lost. `_coerce_message_text` drops the media type, so an unpadded payload
// glued to a caption made only of base64 characters (`A-Z a-z 0-9 + /`) has no
// recoverable boundary and the line-end heuristic removes that caption together
// with the payload. This fixture pins the real behaviour: a RED run asserting
// "the caption survives" failed with an empty copy before it was written this
// way. The control below is the other side of the same limit — the same shape
// with a non-base64 caption stays verbatim, payload included.
test('attachments: base64-only glued caption goes with the unpadded payload (documented limit, not a guarantee)', async () => {
  const glued = 'data:image/png;base64,QUJDRAABthanks'
  const copy = await standard({ history: () => ({ messages: [{ role: 'user', text: glued }] }) })
  await pick(copy, TARGET, 'Copy context')
  const seed = plain(copy.creates[0].params.messages ?? [])
  assert.equal(seed.length, 0, 'the caption is NOT recoverable here: nothing is copied')
  assert.ok(notices(copy).some(message => /no visible messages/i.test(message)), JSON.stringify(notices(copy)))
  copy.dispose()

  const brief = await standard({ history: () => ({ messages: [{ role: 'user', text: glued }] }) })
  await pick(brief, TARGET, 'Brief handoff')
  assert.ok(!/user:/.test(brief.creates[0].params.messages[0].content), 'the lost caption is not excerpted either')
  brief.dispose()

  // Control: a caption that is not pure base64 (here punctuation) is preserved,
  // so the heuristic does not silently eat arbitrary words.
  const kept = 'data:image/png;base64,QUJDRAABthanks, is this the caption?'
  const control = await standard({ history: () => ({ messages: [{ role: 'user', text: kept }] }) })
  await pick(control, TARGET, 'Copy context')
  assert.deepEqual(plain(control.creates[0].params.messages ?? []).slice(1), [{ role: 'user', content: kept }],
    'an unrecoverable boundary keeps the line verbatim — caption present, payload visible as plain text')
  control.dispose()
})

// ── the route guard around every awaited window ────────────────────────────

const notices = h => h.notices.map(notice => String(notice.message))
const routeMutations = [
  ['removed', [SOURCE]],
  ['remapped', [SOURCE, { ...TARGET, targetProfile: 'other' }]],
  ['ambiguous', [SOURCE, TARGET, TARGET]],
  ['offline', null]
]

for (const [name, mutated] of routeMutations) {
  test(`route guard: a ${name} roster after the awaited readback never opens the created chat`, async () => {
    const g = gateway(), gate = deferred()
    let routeReads = 0, coderReads = 0
    let mutatedNow = false
    const h = await standard({
      openSession: async () => { throw Error('open failed') },
      sessions: async r => {
        const rows = g.sessions(r)
        if (r.targetProfile === 'coder') {
          coderReads += 1
          // The recovery read-back is the second coder read; hold it open while
          // the roster changes underneath the pending operation.
          if (coderReads === 2) return gate.promise.then(() => rows)
        }
        return rows
      }
    }, g)
    await pick(h)
    assert.equal(h.opens.length, 2, 'the initial operation exhausts its two open attempts')
    assert.ok(recoveryButton(h))
    h.reader(async () => {
      routeReads += 1
      if (routeReads === 1) return mutatedNow ? mutated : [SOURCE, TARGET]
      if (mutated === null) throw Error('roster offline')
      return mutated
    })
    recoveryButton(h).props.onClick()
    await h.settle()
    mutatedNow = true
    gate.resolve()
    await settle(h)
    assert.equal(h.opens.length, 2, 'no open may be issued from a stale descriptor after the readback resolved')
    assert.equal(h.creates.length, 1, 'the recovery never re-creates')
    assert.ok(notices(h).some(message => /no longer available|changed|ambiguous|verify/i.test(message)), JSON.stringify(notices(h)))
    assert.ok(recoveryButton(h), 'a refused recovery keeps the known ids for a later attempt')
    h.dispose()
  })
}

for (const [name, mutated] of routeMutations) {
  test(`route guard: a ${name} roster while an open is awaited stops the retry`, async () => {
    const g = gateway()
    let mutatedNow = false
    const h = await standard({
      openSession: async () => { mutatedNow = true; throw Error('hydration failed') },
      sessions: g.sessions
    }, g)
    h.reader(async () => (mutatedNow ? (mutated === null ? (() => { throw Error('roster offline') })() : mutated) : [SOURCE, TARGET]))
    await pick(h)
    assert.equal(h.creates.length, 1, 'the create is never repeated by the retry guard')
    assert.equal(h.opens.length, 1, 'the retry must not reuse a descriptor after the roster changed')
    if (mutated === null) assert.ok(notices(h).some(message => /could not verify/i.test(message)), JSON.stringify(notices(h)))
    else assert.ok(notices(h).some(message => /no longer available|changed|ambiguous/i.test(message)), JSON.stringify(notices(h)))
    h.dispose()
  })
}

test('route guard: a stable roster still retries the open once with the same ids', async () => {
  const h = await standard({ openSession: async () => { throw Error('hydration failed') } })
  await pick(h)
  assert.equal(h.creates.length, 1)
  assert.equal(h.opens.length, 2, 'an unchanged route keeps the single open retry')
  h.dispose()
})
