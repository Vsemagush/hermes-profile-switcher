// Shipping-entry style contracts, not computed Windows geometry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, focusState } from './harness.mjs'

test('own root halves inherited composer gap without changing control geometry or host behaviour', async () => {
  for (const owner of [null, { connectionId: 'alpha', profile: 'default' }, { connectionId: 'beta', profile: 'coder' }]) {
    const h = await harness({ focus: focusState(owner) })
    h.render()
    const root = h.tree
    assert.equal(root.type, 'div')
    assert.deepEqual(Object.keys(root.props.style).sort(), ['marginInlineEnd', 'order'])
    assert.equal(root.props.style.order, -1)
    assert.equal(root.props.style.marginInlineEnd, 'calc(var(--composer-control-gap, 0px) * -0.5)')
    // For nonnegative native gaps, half a gap remains: no click-target overlap.
    for (const nativeGap of [0, 2, 4, 8, 12]) {
      const remainingGap = nativeGap + nativeGap * -0.5
      assert.ok(remainingGap >= 0 && remainingGap <= nativeGap)
    }
    const button = h.find('Button')
    assert.equal(button.props.size, 'icon')
    assert.equal(button.props.variant, 'ghost')
    assert.match(button.props.className, /size-\(--composer-control-size\)/)
    assert.equal(button.props.style, undefined)
    assert.equal(h.calls.length, 0)
    assert.ok(!h.hostAccesses.includes('request'))
    await h.open()
    assert.equal(h.tree.props.style.marginInlineEnd, root.props.style.marginInlineEnd)
    h.dispose()
  }
})
