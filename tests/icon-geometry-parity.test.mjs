// Actual shipping-entry style contracts; not computed Electron/Windows geometry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness, focusState, route } from './harness.mjs'

const triggerBadge = h => h.within(h.find('Button'), 'span')
const menuBadge = item => item.props.children[0]
const classes = node => new Set((node.props.className ?? '').split(/\s+/))

// Accept the native utilities or equivalent own inline styles, not class order.
function assertNamedGeometry(badge) {
  assert.equal(badge?.type, 'span', 'named identity remains an own span')
  const tokens = classes(badge)
  const style = badge.props.style ?? {}
  for (const [axis, utility] of [['width', 'w-4'], ['height', 'h-4']]) {
    const dimension = style[axis] ?? (tokens.has('size-4') || tokens.has(utility) ? '1rem' : undefined)
    assert.equal(dimension, '1rem', `named ${axis} matches native 1rem square`)
  }
  assert.equal(style.fontSize ?? (tokens.has('text-[0.5rem]') ? '0.5rem' : undefined), '0.5rem', 'named letter matches native 0.5rem')
  assert.ok(style.lineHeight === 1 || style.lineHeight === '1' || tokens.has('leading-none'), 'native unitless line-height 1')
  assert.ok(style.flexShrink === 0 || tokens.has('shrink-0'), 'named square cannot shrink')
  const display = style.display ?? (tokens.has('grid') ? 'grid' : tokens.has('inline-flex') ? 'inline-flex' : tokens.has('flex') ? 'flex' : undefined)
  const gridCentered = display === 'grid' && (style.placeItems === 'center' || tokens.has('place-items-center'))
  const flexCentered = ['flex', 'inline-flex'].includes(display) &&
    (style.alignItems === 'center' || tokens.has('items-center')) &&
    (style.justifyContent === 'center' || tokens.has('justify-center'))
  assert.ok(gridCentered || flexCentered, 'letter centered on both axes')
  assert.ok(style.borderRadius === '3px' || tokens.has('rounded-[3px]'), 'native 3px corner radius')
  assert.ok(style.fontWeight === 600 || tokens.has('font-semibold'), 'native semibold letter')
  assert.equal(badge.props['aria-hidden'], true)
}

function assertColors(h, badge, profile) {
  const color = h.sdk.profileColor(profile)
  assert.equal(badge.props.style.color, color)
  assert.equal(badge.props.style.backgroundColor, h.sdk.profileColorSoft(color, 22))
}

function assertControl(h) {
  const button = h.find('Button')
  assert.equal(button.props.size, 'icon')
  assert.equal(button.props.variant, 'ghost')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.style, undefined)
  assert.equal(button.props.className, 'size-(--composer-control-size) shrink-0 rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground')
  assert.equal(h.tree.type, 'div')
  assert.deepEqual(Object.keys(h.tree.props.style).sort(), ['marginInlineEnd', 'order'])
  assert.equal(h.tree.props.style.order, -1)
  assert.equal(h.tree.props.style.marginInlineEnd, 'calc(var(--composer-control-gap, 0px) * -0.5)')
  assert.equal(h.contributions[0].area, h.sdk.COMPOSER_AREAS.leading)
  assert.equal(h.find('Tip').props.label, button.props['aria-label'])
  assert.equal(h.calls.length, 0)
  assert.equal(h.rpcCalls.length, 0)
  assert.equal(h.persisted.length, 0)
}

for (const [profile, initial] of [['mellody', 'M'], ['coder', 'C'], ['press', 'P']]) {
  for (const location of ['trigger', 'menu']) {
    test(`${profile} ${location} matches native named geometry without changing identity or colors`, async () => {
      const owner = route('alpha', profile)
      const h = await harness({ routes: [owner], focus: focusState(owner) })
      try {
        await h.open()
        const badge = location === 'trigger' ? triggerBadge(h) : menuBadge(h.items()[0])
        assertNamedGeometry(badge)
        assert.equal(h.text(badge), initial)
        assertColors(h, badge, profile)
        assert.equal(h.find('Button').props['aria-label'], `Focused chat: ${profile} (alpha). New chat with a profile`)
        assertControl(h)
      } finally { h.dispose() }
    })
  }
}

for (const [label, owner, storedId, icon, focusedLabel] of [
  ['default', route(), 'stored', 'home', 'Default (local)'],
  ['unknown', null, 'stored', 'account', 'unknown'],
  ['draft', route('alpha', 'mellody'), null, 'account', 'new draft (owner not indicated)']
]) {
  test(`${label} preserves Codicon sizing, accessible label and outer placement`, async () => {
    const h = await harness({ focus: focusState(owner, storedId) })
    try {
      await h.open()
      assert.equal(triggerBadge(h), undefined)
      const codicon = h.within(h.find('Button'), 'Codicon')
      assert.equal(codicon.props.name, icon)
      assert.equal(codicon.props.size, '0.875rem')
      assert.equal(codicon.props['aria-hidden'], true)
      assert.equal(codicon.props.style, undefined)
      assert.equal(codicon.props.className, undefined)
      const home = menuBadge(h.items()[0])
      assert.equal(home.type, 'sdk.Codicon')
      assert.equal(home.props.name, 'home')
      assert.equal(home.props.className, 'text-(--ui-text-secondary)')
      assert.equal(home.props.size, undefined)
      assert.equal(home.props.style, undefined)
      assert.equal(home.props['aria-hidden'], true)
      assert.equal(h.find('Button').props['aria-label'], `Focused chat: ${focusedLabel}. New chat with a profile`)
      assertControl(h)
    } finally { h.dispose() }
  })
}

for (const missing of ['profileColor', 'profileColorSoft']) {
  test(`missing ${missing} preserves neutral colors with native named geometry`, async () => {
    const owner = route('alpha', 'mellody')
    const h = await harness({ missing, routes: [owner], focus: focusState(owner) })
    try {
      await h.open()
      for (const badge of [triggerBadge(h), menuBadge(h.items()[0])]) {
        assertNamedGeometry(badge)
        assert.equal(badge.props.style.color, 'var(--ui-text-quaternary)')
        assert.equal(badge.props.style.backgroundColor, 'color-mix(in srgb, var(--ui-text-quaternary) 22%, transparent)')
      }
    } finally { h.dispose() }
  })
}
