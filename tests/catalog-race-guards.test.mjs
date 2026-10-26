// Actual-entry regressions for cancellation and the last pre-create mapping check.
// SDK doubles only: no Electron, gateway, network or model execution.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, route, focusState, deferred } from './harness.mjs'

const rounds = async h => { for (let i = 0; i < 12; i++) await h.settle() }
const plain = value => JSON.parse(JSON.stringify(value))
const SOURCE = route('ssh-a', 'default', { targetProfile: 'source-old' })
const TARGET = route('ssh-a', 'coder', { targetProfile: 'target-old' })
const OWNER = { connectionId: SOURCE.connectionId, profile: SOURCE.profile }
const CWD = '/projects/demo'
const history = { count: 1, messages: [{ role: 'user', text: 'Carry this context.' }] }
const named = ids => ({
  id: 'project-demo', path: CWD, isAuto: false, isNoProject: false,
  sessionIds: ids, sessionCount: ids.length,
  repos: [{ id: CWD, path: CWD, sessionCount: ids.length,
    groups: [{ id: CWD, path: CWD, isMain: true, isKanban: false }] }]
})
const home = () => ({
  id: '__no_project__', path: null, isAuto: false, isNoProject: true,
  sessionIds: ['src'], sessionCount: 1,
  repos: [{ id: '__no_project__', path: null, sessionCount: 1,
    groups: [{ id: '__no_project__', path: null, isMain: false, isKanban: false, sessions: [] }] }]
})
const noWrites = h => {
  assert.equal(h.creates.length, 0, 'no create may reach a stale or abandoned route')
  assert.equal(h.titles.length, 0)
  assert.equal(h.opens.length, 0)
  assert.equal(h.calls.length, 0)
}

for (const change of ['unchanged', 'navigation', 'away-and-back', 'dispose', 'unmount', 'new-generation']) {
  test(`plain fallback roster await: ${change}`, async t => {
    const focus = focusState(OWNER, null, 'draft')
    const h = await harness({ routes: [SOURCE, TARGET], focus })
    const gate = deferred()
    t.after(() => { gate.resolve([SOURCE, TARGET]); h.dispose() })
    await h.open()
    const item = h.items().find(n => h.text(n).includes('coder'))
    h.reader(() => gate.promise)
    h.select(item)
    await rounds(h)
    if (change === 'navigation' || change === 'away-and-back' || change === 'new-generation') {
      focus.runtime('elsewhere')
      if (change === 'away-and-back') focus.runtime('draft')
    }
    if (change === 'dispose') h.dispose()
    if (change === 'unmount') h.unmount()
    if (change === 'new-generation') {
      h.reader(() => [SOURCE, TARGET])
      h.select(item)
      await rounds(h)
    }
    gate.resolve([SOURCE, TARGET])
    await rounds(h)
    assert.equal(h.calls.length, ['unchanged', 'new-generation'].includes(change) ? 1 : 0,
      'abandoned plain-newChat must not navigate, including away-and-back')
    assert.equal(h.creates.length, 0)
  })
}

for (const missing of ['host.listPersistedSessions', 'host.requestProfile']) {
  test(`plain fallback preserves optional capability absence: ${missing}`, async t => {
    const h = await harness({ routes: [SOURCE, TARGET], missing })
    t.after(() => h.dispose())
    await h.open()
    h.select(h.items().find(n => h.text(n).includes('coder')))
    await rounds(h)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(plain(h.calls[0][0]), TARGET)
  })
}

const changes = ['unchanged', 'remap', 'missing', 'duplicate', 'unreadable', 'malformed']
function rosterWith(change, which, source, target) {
  const selected = which === 'source' ? source : target
  const others = source === target ? [] : [which === 'source' ? target : source]
  if (change === 'unreadable') throw Error('roster unavailable')
  if (change === 'missing') return others
  if (change === 'duplicate') return [...others, selected, selected]
  if (change === 'remap') return [...others, { ...selected, targetProfile: 'remapped-backend' }]
  if (change === 'malformed') return [...others, { ...selected, targetProfile: '' }]
  return [...others, selected]
}

async function setup({ topology, same = false, gateAt = 'history' }) {
  const source = SOURCE
  const target = same ? source : topology === 'cross-gateway'
    ? route('ssh-b', 'coder', { targetProfile: 'target-old' }) : TARGET
  const gate = deferred()
  let reached = false, count = 0
  const pause = async value => { reached = true; await gate.promise; return value }
  const h = await harness({
    routes: same ? [source] : [source, target],
    focus: focusState(OWNER, 'src', 'rt-src'),
    sessions: r => [
      ...(r.profile === source.profile ? [{ id: 'src', profile: source.targetProfile,
        cwd: topology === 'Home' ? null : CWD, message_count: 1 }] : []),
      ...(r.profile === target.profile && count >= 0 ? [{ id: 'new', profile: target.targetProfile,
        cwd: topology === 'project' ? CWD : null, message_count: count }] : [])
    ],
    projects: async r => {
      const nodes = [topology === 'Home' ? home() : named(r.profile === source.profile ? ['src'] : [])]
      return gateAt === 'project' && (same || r.profile === target.profile) ? pause(nodes) : nodes
    },
    history: () => gateAt === 'history' ? pause(history) : history,
    create: (_r, params) => {
      count = params.messages?.length ?? 0
      return { session_id: 'rt-new', stored_session_id: 'new' }
    },
    title: () => ({ pending: false }), openSession: async () => {}
  })
  return { h, gate, source, target, reached: () => reached }
}

for (const topology of ['project', 'Home', 'cross-gateway']) {
  for (const action of ['Copy context', 'Brief handoff']) {
    for (const which of ['source', 'target']) {
      for (const change of changes) {
        test(`pre-create ${topology}/${action}: ${which} ${change} during history`, async t => {
          const { h, gate, source, target, reached } = await setup({ topology })
          t.after(() => { gate.resolve(); h.dispose() })
          await h.open()
          h.select(h.items().find(n => h.text(n).includes('coder')))
          await rounds(h)
          h.dialogAction(action).props.onClick()
          await rounds(h)
          assert.equal(reached(), true, 'the real entry reached the last history read')
          h.reader(() => rosterWith(change, which, source, target))
          gate.resolve()
          await rounds(h)
          if (change !== 'unchanged') noWrites(h)
          else {
            assert.equal(h.creates.length, 1, 'unchanged full mappings still create once')
            assert.equal(h.opens.length, 1)
            assert.deepEqual(plain(h.creates[0].route), target)
            assert.equal(h.creates[0].params.profile, target.targetProfile)
            assert.match(JSON.stringify(h.creates[0].params.messages), /Carry this context/)
          }
        })
      }
    }
  }
}

for (const same of [false, true]) {
  for (const which of same ? ['source'] : ['source', 'target']) {
    for (const change of changes) {
      test(`pre-create fresh project same=${same}: ${which} ${change} during project read`, async t => {
        const { h, gate, source, target, reached } = await setup({ topology: 'project', same, gateAt: 'project' })
        t.after(() => { gate.resolve(); h.dispose() })
        await h.open()
        h.select(h.items().find(n => h.text(n).includes(same ? 'Default' : 'coder')))
        await rounds(h)
        if (!same) { h.dialogAction('Start fresh').props.onClick(); await rounds(h) }
        assert.equal(reached(), true, 'the real entry reached the project read')
        h.reader(() => same ? rosterWith(change, which, source, target).filter((r, i) => change !== 'unchanged' || i === 0)
          : rosterWith(change, which, source, target))
        gate.resolve()
        await rounds(h)
        if (change !== 'unchanged') noWrites(h)
        else {
          assert.equal(h.creates.length, 1)
          assert.equal(h.titles.length, 1)
          assert.equal(h.opens.length, 1)
          assert.equal(h.histories.length, 0)
        }
      })
    }
  }
}

for (const change of ['unchanged', 'navigation', 'away-and-back', 'dispose', 'unmount']) {
  test(`last mapping await rechecks lifecycle: ${change}`, async t => {
    const { h, gate: historyGate, source, target } = await setup({ topology: 'project' })
    const mappingGate = deferred()
    let reached = false
    t.after(() => { historyGate.resolve(); mappingGate.resolve([source, target]); h.dispose() })
    await h.open()
    h.select(h.items().find(n => h.text(n).includes('coder')))
    await rounds(h)
    h.dialogAction('Copy context').props.onClick()
    await rounds(h)
    h.reader(() => { reached = true; return mappingGate.promise })
    historyGate.resolve()
    await rounds(h)
    assert.equal(reached, true, 'create must first await fresh full mappings')
    assert.equal(h.creates.length, 0, 'no write before the final mapping read resolves')
    if (change === 'navigation' || change === 'away-and-back') {
      h.focus.runtime('elsewhere')
      if (change === 'away-and-back') h.focus.runtime('rt-src')
    }
    if (change === 'dispose') h.dispose()
    if (change === 'unmount') h.unmount()
    mappingGate.resolve([source, target])
    await rounds(h)
    assert.equal(h.creates.length, change === 'unchanged' ? 1 : 0)
  })
}
