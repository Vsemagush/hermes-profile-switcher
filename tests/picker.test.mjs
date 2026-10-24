// Runtime behaviour tests for the shipping plugin entry (desktop/plugin.js).
// SDK/React doubles come from tests/harness.mjs and are explicitly mocks:
// no Electron, no gateway, no Radix, no model calls are involved.
import test from 'node:test'
import assert from 'node:assert/strict'

import { harness, route } from './harness.mjs'

const LABEL = 'New chat with a profile'
const noSend = (calls, expectedLength = 1) => {
  assert.equal(calls.length, expectedLength, `expected ${expectedLength} newChat call(s), got ${calls.length}`)
  for (const args of calls) assert.equal(typeof args[0], 'object', 'newChat must receive a route descriptor, never a name')
}
const messages = notices => notices.map(notice => String(notice.message))

test('registers exactly one composer leading contribution with cleanup', async () => {
  const h = await harness()
  h.render()
  assert.equal(h.contributions.length, 1)
  assert.equal(h.contributions[0].area, 'composer.leading')
  assert.equal(typeof h.contributions[0].render, 'function')
  assert.ok(h.find('DropdownMenu'), 'menu must come from the SDK DropdownMenu primitive')
  assert.equal(h.nodes().filter(node => node.type === 'sdk.DropdownMenu').length, 1)
  assert.equal(h.nodes()[0].props.style.order, -1, 'the contribution root keeps the inline order hint')
  h.dispose()
})

test('unknown focused owner exposes the action and a neutral icon, without a text plate', async () => {
  const h = await harness()
  h.render()
  assert.equal(h.find('Tip').props.label, `Focused chat: unknown. ${LABEL}`)
  assert.equal(h.find('Button').props['aria-label'], `Focused chat: unknown. ${LABEL}`)
  assert.equal(h.find('Button').props.type, 'button')
  const trigger = h.find('DropdownMenuTrigger')
  assert.equal(trigger.props.asChild, true)
  assert.ok(h.find('Codicon'), 'the trigger renders an icon component')
  assert.deepEqual(h.find('Button').props.children, h.find('Codicon'), 'the icon is the trigger content')
  assert.equal(h.find('Button').props.variant, 'ghost')
})

test('menu shows the default profile with a home glyph and a named profile with initials', async () => {
  const h = await harness({ routes: [route('local', 'default'), route('local', 'press-bot')] })
  await h.open()
  const items = h.items()
  assert.equal(items.length, 2)
  const [home, named] = items
  assert.equal(h.text(home).trim(), 'Default')
  assert.equal(h.within(home, 'Codicon').props.name, 'home')
  assert.match(h.text(named), /press-bot/)
  const initials = h.within(named, 'span')
  assert.equal(h.text(initials), 'P')
  assert.match(initials.props.style.color, /^var\(--/)
  assert.match(initials.props.style.backgroundColor, /^color-mix\(in srgb, var\(--/)
})

test('same-name profiles on two connections stay distinguishable and route to their own source', async () => {
  const h = await harness({
    routes: [route('alpha', 'press'), route('beta', 'press'), route('alpha', 'default')]
  })
  await h.open()
  const items = h.items()
  assert.equal(items.length, 3)
  const alpha = items.filter(item => h.text(item).includes('press') && h.text(item).includes('alpha'))
  const beta = items.filter(item => h.text(item).includes('press') && h.text(item).includes('beta'))
  assert.equal(alpha.length, 1, 'the alpha source carries its connection qualifier')
  assert.equal(beta.length, 1, 'the beta source carries its connection qualifier')
  const plain = items.filter(item => h.text(item).includes('Default'))
  assert.equal(plain.length, 1)
  assert.ok(!h.text(plain[0]).includes('alpha'), 'an unambiguous name needs no qualifier')

  h.select(alpha[0])
  await h.settle()
  noSend(h.calls)
  assert.equal(h.calls[0][0].connectionId, 'alpha')
  h.select(beta[0])
  await h.settle()
  noSend(h.calls, 2)
  assert.equal(h.calls[1][0].connectionId, 'beta')
  assert.deepEqual(h.calls[0][0], route('alpha', 'press'))
  assert.deepEqual(h.calls[1][0], route('beta', 'press'))
})

test('passes the full refreshed descriptor, including extra source fields', async () => {
  const extra = { primary: true, label: 'Remote press', deprecated: false }
  const h = await harness({ routes: [route('studio', 'press', extra)] })
  await h.open()
  const [item] = h.items()
  h.select(item)
  await h.settle()
  noSend(h.calls)
  assert.deepEqual(h.calls[0][0], route('studio', 'press', extra))
  assert.deepEqual(Object.keys(h.calls[0][0]).sort(), Object.keys(route('studio', 'press', extra)).sort())
})

test('malformed routes are rejected with an explicit error while valid routes stay selectable', async () => {
  const malformed = [
    { profile: 'no-connection', targetProfile: 'no-connection', mode: 'local' },
    { connectionId: 'local', profile: '', targetProfile: 'x', mode: 'local' },
    { connectionId: 'local', profile: 'bad-mode', targetProfile: 'bad-mode', mode: 'sideways' },
    { connectionId: 'local', profile: 'no-target', mode: 'local' },
    null
  ]
  const h = await harness({ routes: [route('local', 'good'), ...malformed] })
  await h.open()
  const items = h.items()
  assert.equal(items.length, 1, 'only the well-formed route is selectable')
  assert.match(h.text(items[0]), /\bgood\b/)
  assert.ok(!h.text(items[0]).includes('bad-mode'))
  const menu = h.text(h.find('DropdownMenuContent'))
  assert.match(menu, /invalid/i, 'the ignored routes are named in the menu')
  assert.ok(!/no-connection|bad-mode|no-target/.test(menu), 'a rejected route is never offered as a row')
  h.select(items[0])
  await h.settle()
  noSend(h.calls)
  assert.equal(h.calls[0][0].profile, 'good')
})

test('duplicate identity routes are ambiguous and never selectable', async () => {
  const h = await harness({ routes: [route('alpha', 'press'), route('alpha', 'press'), route('alpha', 'default')] })
  await h.open()
  const items = h.items()
  assert.equal(items.length, 1)
  assert.equal(h.text(items[0]).trim(), 'Default')
  assert.match(h.text(h.find('DropdownMenuContent')), /ambiguous/i)
  h.select(items[0])
  await h.settle()
  noSend(h.calls)
  assert.equal(h.calls[0][0].profile, 'default')
})

test('a route removed between list and click is refused with an error and no call', async () => {
  const h = await harness({ routes: [route('local', 'default'), route('local', 'press')] })
  await h.open()
  const press = h.items().find(item => h.text(item).includes('press'))
  h.reader(async () => [route('local', 'default')])
  h.select(press)
  await h.settle()
  assert.equal(h.calls.length, 0)
  assert.ok(messages(h.notices).some(message => /no longer/i.test(message)))
})

test('a remapped route is refused instead of being opened or redirected', async () => {
  const h = await harness({ routes: [route('local', 'press')] })
  await h.open()
  const [item] = h.items()
  h.reader(async () => [route('local', 'press', { targetProfile: 'archive' })])
  h.select(item)
  await h.settle()
  assert.equal(h.calls.length, 0)
  assert.ok(messages(h.notices).some(message => /changed/i.test(message)))

  h.reader(async () => [route('local', 'press', { mode: 'remote' })])
  h.select(item)
  await h.settle()
  assert.equal(h.calls.length, 0, 'a mode change is a remap too')
})

test('a failed route refresh refuses the click instead of opening a chat', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  const [item] = h.items()
  h.reader(async () => { throw new Error('gateway offline') })
  h.select(item)
  await h.settle()
  assert.equal(h.calls.length, 0)
  assert.ok(messages(h.notices).some(message => /could not verify/i.test(message)))
})

test('rapid duplicate clicks produce one newChat', async () => {
  const h = await harness({ routes: [route('local', 'default'), route('local', 'press')] })
  await h.open()
  const items = h.items()
  const slow = []
  h.reader(async () => new Promise(resolve => slow.push(resolve)))
  h.select(items[0])
  h.select(items[0])
  h.select(items[1])
  assert.equal(h.calls.length, 0)
  assert.equal(slow.length, 1, 'only one refresh is in flight')
  slow[0]([route('local', 'default'), route('local', 'press')])
  await h.settle()
  noSend(h.calls)
  assert.equal(h.calls[0][0].profile, 'default')
})

test('a selection that resolves after disposal opens nothing', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  const [item] = h.items()
  let release
  h.reader(() => new Promise(resolve => { release = resolve }))
  h.select(item)
  h.dispose()
  release([route('local', 'default')])
  await h.settle()
  assert.equal(h.calls.length, 0)
})

test('a selection that resolves after unmount opens nothing either', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  const [item] = h.items()
  let release
  h.reader(() => new Promise(resolve => { release = resolve }))
  h.select(item)
  h.unmount()
  release([route('local', 'default')])
  await h.settle()
  assert.equal(h.calls.length, 0)
})

test('a StrictMode-style effect re-run re-arms the picker instead of killing it', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  h.remount()
  const [item] = h.items()
  assert.ok(item, 'the menu still renders after an effect re-run')
  h.select(item)
  await h.settle()
  noSend(h.calls)
  assert.equal(h.calls[0][0].profile, 'default')
})

test('opening the menu after a disposal never resumes the disposed flow', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  const [item] = h.items()
  let release
  h.reader(() => new Promise(resolve => { release = resolve }))
  h.select(item)
  h.dispose()
  await h.open()
  release([route('local', 'default')])
  await h.settle()
  assert.equal(h.calls.length, 0)
})

test('roster states are honest: loading, error with retry, empty, single profile', async () => {
  let release
  const h = await harness()
  h.reader(() => new Promise(resolve => { release = resolve }))
  h.render()
  h.find('DropdownMenu').props.onOpenChange(true)
  h.render()
  assert.match(h.text(h.find('DropdownMenuContent')), /loading/i)
  release([route('local', 'default'), route('local', 'press')])
  await h.settle()
  assert.equal(h.items().length, 2)

  const failed = await harness()
  failed.reader(async () => { throw new Error('gateway offline') })
  await failed.open()
  assert.match(failed.text(failed.find('DropdownMenuContent')), /could not load/i)
  assert.equal(failed.items().length, 0, 'a failure is never shown as an empty roster')
  failed.reader(async () => [route('local', 'default')])
  const retry = failed.nodes().find(node => node.type === 'sdk.Button' && /retry/i.test(failed.text(node)))
  assert.ok(retry, 'the error state offers a retry')
  retry.props.onClick()
  await failed.settle()
  assert.equal(failed.items().length, 1)

  const empty = await harness({ routes: [] })
  await empty.open()
  assert.match(empty.text(empty.find('DropdownMenuContent')), /no profiles/i)
  assert.equal(empty.items().length, 0)

  const single = await harness({ routes: [route('local', 'solo')] })
  await single.open()
  assert.equal(single.items().length, 1)
  assert.ok(single.find('Button'), 'the trigger stays available with a single profile')
  single.select(single.items()[0])
  await single.settle()
  noSend(single.calls)
  assert.equal(single.calls[0][0].profile, 'solo')
})

test('a missing host API yields an inactive notice instead of a broken control', async () => {
  const noRoutes = await harness({ missing: 'host.profileRoutes' })
  noRoutes.render()
  assert.equal(noRoutes.contributions.length, 1)
  assert.match(noRoutes.text(), /unavailable/i)
  assert.equal(noRoutes.nodes().filter(node => node.type === 'sdk.DropdownMenu').length, 0)
  assert.deepEqual(noRoutes.calls, [])

  const noNewChat = await harness({ missing: 'host.newChat' })
  noNewChat.render()
  assert.match(noNewChat.text(), /unavailable/i)
  assert.equal(noNewChat.find('DropdownMenu'), undefined)
})

test('missing SDK UI members yield the same inactive notice', async () => {
  for (const member of ['DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'Button', 'Codicon', 'Tip']) {
    const h = await harness({ missing: member })
    h.render()
    assert.match(h.text(), /unavailable/i, `missing ${member} must deactivate the picker`)
    assert.equal(h.find('DropdownMenu'), undefined)
  }
  const noArea = await harness({ missing: 'leading' })
  noArea.render()
  assert.equal(noArea.contributions.length, 0, 'with no known slot the plugin registers nothing at all')
  assert.equal(noArea.text(), '')
  assert.deepEqual(noArea.calls, [])
})

test('only the readonly route read and one newChat are ever issued', async () => {
  const h = await harness({ routes: [route('local', 'default'), route('local', 'press')] })
  await h.open()
  const before = h.reads
  h.select(h.items()[0])
  await h.settle()
  noSend(h.calls)
  assert.equal(h.reads, before + 1, 'selection revalidates the route list exactly once')
  assert.equal(h.listReads, 0, 'no roster metadata read is issued, so display data cannot cross sources')
})

test('a failing metadata source cannot hide routes or change labels', async () => {
  const h = await harness({
    routes: [route('alpha', 'press'), route('beta', 'press')],
    metadata: async () => { throw new Error('metadata offline') }
  })
  await h.open()
  assert.equal(h.items().length, 2)
  assert.equal(h.listReads, 0)
  assert.match(h.text(h.items()[0]), /alpha/)
})

test('menu items are SDK primitives wired to selection, and the menu closes without host actions', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  const [item] = h.items()
  assert.equal(typeof item.props.onSelect, 'function')
  h.find('DropdownMenu').props.onOpenChange(false)
  h.render()
  assert.equal(h.find('DropdownMenuContent'), undefined, 'closing unmounts the menu content')
  assert.equal(h.calls.length, 0)
  assert.equal(h.notices.length, 0)
})

test('the plugin touches only readonly routes/focused atoms and the one new-chat call', async () => {
  const h = await harness({ routes: [route('local', 'default')] })
  await h.open()
  h.select(h.items()[0])
  await h.settle()
  noSend(h.calls)
  // The three handoff doors are only feature-detected at registration and are
  // never called for a source without a confirmed context.
  assert.deepEqual(h.hostAccesses, ['profileRoutes', 'newChat', 'state', 'listPersistedSessions', 'requestProfile', 'openSession'], 'no draft, session, model or storage API is read')
  assert.deepEqual(h.stateAccesses, ['focusedSessionOwner', 'focusedStoredSessionId', 'focusedSessionId'], 'no active-profile or legacy fallback is read')
  assert.deepEqual(h.ctxAccesses, ['onDispose', 'register'], 'no middleware, attachment provider or storage contribution')
})
