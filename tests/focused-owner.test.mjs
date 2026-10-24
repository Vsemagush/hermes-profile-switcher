// Shipping-entry boundary contracts, not Electron/computed Windows geometry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, focusState } from './harness.mjs'

test('trigger follows native composer control size and glyph contract, not fixed icon-sm', async () => {
  const h = await harness()
  h.render()
  const button = h.find('Button')
  assert.equal(button.props.size, 'icon')
  assert.equal(button.props.variant, 'ghost')
  assert.match(button.props.className, /\bsize-\(--composer-control-size\)/)
  assert.match(button.props.className, /shrink-0/)
  assert.match(button.props.className, /rounded-md/)
  assert.equal(h.find('Codicon').props.size, '0.875rem')
})

test('global focused readout reacts across mounted controls, including same-name source changes', async () => {
  const focus = focusState({ connectionId: 'alpha', profile: 'default' })
  const controls = [await harness({ focus }), await harness({ focus })]
  for (const h of controls) {
    h.render()
    assert.equal(h.find('Button').props['aria-label'], 'Focused chat: Default (alpha). New chat with a profile')
    assert.equal(h.find('Codicon').props.name, 'home')
    assert.equal(h.find('Codicon').props.size, '0.875rem')
  }
  for (const connectionId of ['alpha', 'beta']) {
    focus.owner({ connectionId, profile: 'press' })
    for (const h of controls) {
      const label = `Focused chat: press (${connectionId}). New chat with a profile`
      assert.equal(h.find('Button').props['aria-label'], label)
      assert.equal(h.find('Tip').props.label, label)
      assert.equal(h.text(h.find('Button')), 'P')
      const badge = h.within(h.find('Button'), 'span')
      assert.match(badge.props.style.color, /^var\(--/)
      assert.match(badge.props.style.backgroundColor, /^color-mix\(in srgb, var\(--/)
    }
  }
  assert.equal(focus.subscriptions(), 4)
  controls[0].unmount()
  assert.equal(focus.subscriptions(), 2)
  controls[1].dispose()
  assert.equal(focus.subscriptions(), 0)
  focus.owner({ connectionId: 'other', profile: 'default' })
  assert.equal(controls.flatMap(h => h.calls).length, 0)
})

test('null and malformed owners are unknown, never active-profile fallbacks', async () => {
  const focus = focusState()
  const h = await harness({ focus })
  h.render()
  for (const owner of [null, {}, [], 'press', { profile: 'press' }, { connectionId: '', profile: 'press' }, { connectionId: 'alpha', profile: ' ' }, { connectionId: 42, profile: 'press' }]) {
    focus.owner(owner)
    assert.equal(h.find('Button').props['aria-label'], 'Focused chat: unknown. New chat with a profile')
    assert.equal(h.find('Codicon').props.name, 'account')
  }
  h.unmount()
})

test('no stored focus is a draft, malformed identity is unknown, identity-only focus changes react', async () => {
  const focus = focusState({ connectionId: 'alpha', profile: 'press' }, null)
  const h = await harness({ focus })
  h.render()
  assert.equal(h.find('Button').props['aria-label'], 'Focused chat: new draft (owner not indicated). New chat with a profile')
  assert.equal(h.find('Codicon').props.name, 'account')
  focus.storedId('stored')
  assert.match(h.find('Tip').props.label, /press \(alpha\)/)
  focus.storedId({ id: 'invalid' })
  assert.match(h.find('Tip').props.label, /Focused chat: unknown/)
  focus.storedId(null)
  assert.match(h.find('Tip').props.label, /new draft/)
  h.unmount()
})

test('missing optional readout stays unknown while validated newChat still works', async () => {
  for (const missing of ['state.focusedSessionOwner', 'state.focusedStoredSessionId', 'host.state', 'useValue']) {
    const h = await harness({ missing, focus: focusState({ connectionId: 'alpha', profile: 'press' }) })
    await h.open()
    assert.equal(h.find('Button').props['aria-label'], 'Focused chat: unknown. New chat with a profile')
    h.select(h.items()[0])
    await h.settle()
    assert.equal(h.calls.length, 1)
    h.unmount()
  }
})

test('known owner survives loading, route error and empty roster without menu matching', async () => {
  for (const kind of ['loading', 'error', 'empty']) {
    const h = await harness({ routes: [], focus: focusState({ connectionId: 'offline-source', profile: 'press' }) })
    if (kind === 'loading') h.reader(() => new Promise(() => {}))
    if (kind === 'error') h.reader(async () => { throw Error('offline') })
    await h.open()
    assert.equal(h.find('Button').props['aria-label'], 'Focused chat: press (offline-source). New chat with a profile')
    assert.equal(h.text(h.find('Button')), 'P')
    assert.equal(h.calls.length, 0)
    h.unmount()
  }
})
