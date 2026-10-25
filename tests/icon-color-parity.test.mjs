// Actual shipping entry with symbolic public SDK colors, not Electron rendering.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, focusState, route } from './harness.mjs'

const triggerBadge = h => h.within(h.find('Button'), 'span')
const menuBadge = item => item.props.children[0]
const expected = (h, profile) => {
  const color = h.sdk.profileColor(profile)
  return { backgroundColor: h.sdk.profileColorSoft(color, 22), color }
}
const assertColors = (badge, colors) => {
  assert.ok(badge, 'identity badge remains visible')
  assert.equal(badge.props.style.backgroundColor, colors.backgroundColor, 'native soft fill')
  assert.equal(badge.props.style.color, colors.color, 'native profile ink')
  assert.doesNotMatch(JSON.stringify(badge.props.style), /--ui-accent/)
}
const assertNoReads = h => {
  assert.equal(h.listReads, 0)
  assert.equal(h.rpcCalls.length, 0)
  assert.equal(h.persisted.length, 0)
}

test('named menu and trigger delegate fill/ink to public profile helpers at 22%', async () => {
  const h = await harness({ routes: [route('alpha', 'mellody')], focus: focusState(route('alpha', 'mellody')) })
  await h.open()
  assertColors(triggerBadge(h), expected(h, 'mellody'))
  assertColors(menuBadge(h.items()[0]), expected(h, 'mellody'))
  assert.equal(h.text(triggerBadge(h)), 'M')
  assert.equal(h.text(menuBadge(h.items()[0])), 'M')
  assertNoReads(h)
  h.dispose()
})

test('names colliding in the old four-tint palette now use distinct SDK colors', async () => {
  // local/a and local/e collide under the removed 31-hash modulo four.
  const oldTintIndex = profile => {
    let hash = 0
    for (const char of `local/${profile}`) hash = (hash * 31 + char.charCodeAt(0)) % 100000
    return hash % 4
  }
  assert.equal(oldTintIndex('a'), oldTintIndex('e'))
  const h = await harness({ routes: [route('local', 'a'), route('local', 'e')] })
  await h.open()
  const [a, e] = h.items().map(menuBadge)
  assertColors(a, expected(h, 'a'))
  assertColors(e, expected(h, 'e'))
  assert.notEqual(a.props.style.backgroundColor, e.props.style.backgroundColor)
  assertNoReads(h)
  h.dispose()
})

test('default keeps home codicons without a colored identity badge', async () => {
  const h = await harness({ focus: focusState(route()) })
  await h.open()
  assert.equal(h.within(h.find('Button'), 'Codicon').props.name, 'home')
  assert.equal(triggerBadge(h), undefined)
  assert.equal(menuBadge(h.items()[0]).props.name, 'home')
  assert.equal(menuBadge(h.items()[0]).props.style, undefined)
  assertNoReads(h)
  h.dispose()
})

for (const [label, owner, storedId] of [
  ['unknown', null, 'stored'],
  ['malformed', { profile: 'mellody' }, 'stored'],
  ['draft', route('alpha', 'mellody'), null]
]) {
  test(`${label} keeps account without guessing a profile color`, async () => {
    const h = await harness({ focus: focusState(owner, storedId) })
    await h.open()
    assert.equal(h.within(h.find('Button'), 'Codicon').props.name, 'account')
    assert.equal(triggerBadge(h), undefined)
    assertNoReads(h)
    h.dispose()
  })
}

test('same name across gateways shares native hue but preserves keys, qualifiers and routing', async () => {
  const routes = [route('alpha', 'mellody'), route('beta', 'mellody')]
  const focus = focusState(null)
  const h = await harness({ routes, focus })
  await h.open()
  const [alpha, beta] = h.items()
  assert.notEqual(alpha.key, beta.key)
  assert.equal(alpha.key, 'alpha\u0000mellody')
  assert.equal(beta.key, 'beta\u0000mellody')
  assert.notEqual(h.text(alpha), h.text(beta))
  assert.match(h.text(alpha), /alpha/)
  assert.match(h.text(beta), /beta/)
  for (const item of [alpha, beta]) assertColors(menuBadge(item), expected(h, 'mellody'))
  focus.owner(routes[0])
  const alphaLabel = h.find('Button').props['aria-label']
  const alphaFill = triggerBadge(h).props.style.backgroundColor
  focus.owner(routes[1])
  assert.notEqual(h.find('Button').props['aria-label'], alphaLabel)
  assert.equal(triggerBadge(h).props.style.backgroundColor, alphaFill)
  focus.owner(null)
  h.select(beta)
  await h.settle()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0].connectionId, 'beta')
  assert.equal(h.calls[0][0].profile, 'mellody')
  assertNoReads(h)
  h.dispose()
})

for (const missing of ['profileColor', 'profileColorSoft']) {
  test(`missing ${missing} uses neutral soft fill in trigger and menu`, async () => {
    const h = await harness({ missing, routes: [route('alpha', 'mellody')], focus: focusState(route('alpha', 'mellody')) })
    await h.open()
    const neutral = {
      backgroundColor: 'color-mix(in srgb, var(--ui-text-quaternary) 22%, transparent)',
      color: 'var(--ui-text-quaternary)'
    }
    assertColors(triggerBadge(h), neutral)
    assertColors(menuBadge(h.items()[0]), neutral)
    assertNoReads(h)
    h.dispose()
  })
}

for (const end of ['dispose', 'unmount']) {
  test(`focused owner recolors reactively and ${end} releases subscriptions`, async () => {
    const focus = focusState(route('alpha', 'mellody'))
    const h = await harness({ focus })
    h.render()
    assertColors(triggerBadge(h), expected(h, 'mellody'))
    const firstFill = triggerBadge(h).props.style.backgroundColor
    focus.owner(route('beta', 'press'))
    assertColors(triggerBadge(h), expected(h, 'press'))
    assert.notEqual(triggerBadge(h).props.style.backgroundColor, firstFill)
    assert.match(h.find('Button').props['aria-label'], /press \(beta\)/)
    assert.equal(focus.subscriptions(), 2)
    h[end]()
    assert.equal(focus.subscriptions(), 0)
    const tree = h.tree
    focus.owner(route())
    assert.equal(h.tree, tree)
    assertNoReads(h)
  })
}

for (const state of ['loading', 'error', 'empty']) {
  test(`${state} roster leaves focused identity visible with native color`, async () => {
    const h = await harness({ routes: [], focus: focusState(route('offline', 'mellody')) })
    if (state === 'loading') h.reader(() => new Promise(() => {}))
    if (state === 'error') h.reader(async () => { throw Error('offline') })
    await h.open()
    assertColors(triggerBadge(h), expected(h, 'mellody'))
    assert.match(h.find('Button').props['aria-label'], /mellody \(offline\)/)
    assert.equal(h.calls.length, 0)
    assertNoReads(h)
    h.dispose()
    assert.equal(h.focus.subscriptions(), 0)
  })
}
