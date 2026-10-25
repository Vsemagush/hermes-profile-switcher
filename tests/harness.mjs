// Explicit SDK/React mocks: no Electron, Radix, network or model execution.
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

export const route = (connectionId = 'local', profile = 'default', extra = {}) => ({
  connectionId, profile, targetProfile: profile, mode: connectionId === 'local' ? 'local' : 'remote', ...extra
})
export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
export function focusState(owner = null, storedId = 'stored-chat', runtimeId = 'runtime-chat') {
  const make = initial => {
    let value = initial
    const listeners = new Set()
    const atom = new Proxy({
      get: () => value,
      subscribe(fn) { listeners.add(fn); fn(value); return () => listeners.delete(fn) }
    }, {
      get(target, key) {
        if (!(key in target)) throw Error(`Forbidden atom access: ${String(key)}`)
        return target[key]
      },
      set() { throw Error('Forbidden atom write') }
    })
    return { atom, update(next) { value = next; for (const fn of [...listeners]) fn(value) }, count: () => listeners.size }
  }
  const ownerState = make(owner), idState = make(storedId), runtimeState = make(runtimeId)
  return {
    atoms: {
      focusedSessionOwner: ownerState.atom,
      focusedStoredSessionId: idState.atom,
      focusedSessionId: runtimeState.atom
    },
    owner: ownerState.update, storedId: idState.update, runtime: runtimeState.update,
    subscriptions: () => ownerState.count() + idState.count() + runtimeState.count()
  }
}
export async function harness({ routes = [route()], missing, metadata, focus = focusState(), sessions, projects, create, title, history, openSession, crypto = webcrypto } = {}) {
  const calls = [], notices = [], contributions = [], disposers = [], effects = []
  const hostAccesses = [], ctxAccesses = [], stateAccesses = []
  const persisted = [], rpcCalls = [], creates = [], titles = [], opens = [], treeCalls = [], histories = []
  const slots = []
  let cursor = 0, tree, mounted = true, reads = 0, listReads = 0, renderFn
  let reader = async () => routes
  const hooks = {
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { if (mounted) slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useId() { const [id] = hooks.useState('mock-view'); return id },
    useEffect(fn, deps) {
      const i = cursor++
      if (!slots[i] || !equalDeps(slots[i].deps, deps)) {
        effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() } })
      }
    }
  }
  const state = new Proxy({ ...focus.atoms }, {
    get(target, key) {
      stateAccesses.push(key)
      if (!['focusedSessionOwner', 'focusedStoredSessionId', 'focusedSessionId'].includes(key)) throw Error(`Forbidden state access: ${String(key)}`)
      return target[key]
    },
    set() { throw Error('Forbidden state write') }
  })
  // Source route descriptor for the persisted read-back; profile-scoped methods
  // answer for the profile the descriptor names.
  const persistedPage = async (route, options) => {
    const rows = typeof sessions === 'function' ? await sessions(route, options) : sessions
    return Array.isArray(rows) ? { sessions: rows, total: rows.length } : rows
  }
  const projectsFor = async (route, params) => {
    const nodes = typeof projects === 'function' ? await projects(route, params) : projects
    return Array.isArray(nodes) ? nodes : []
  }
  const host = new Proxy({
    state,
    profileRoutes: async () => { reads++; return reader() },
    newChat: (...args) => { calls.push(args) },
    notify: notice => notices.push(notice),
    profiles: { list: async (...args) => { listReads++; return metadata?.(...args) } },
    listPersistedSessions: async (...args) => {
      const [routeArg, options] = args
      persisted.push({ options, route: routeArg })
      if (!sessions) throw Error('listPersistedSessions is not configured in this harness')
      return persistedPage(routeArg, options)
    },
    requestProfile: async (...args) => {
      const [routeArg, method, params, timeoutMs] = args
      rpcCalls.push({ method, params: params ?? {}, route: routeArg, timeoutMs })
      if (method === 'projects.tree') {
        treeCalls.push({ params: params ?? {}, route: routeArg })
        if (!projects) throw Error('projects.tree is not configured in this harness')
        return { projects: await projectsFor(routeArg, params ?? {}), active_id: null, scoped_session_ids: [] }
      }
      if (method === 'session.create') {
        creates.push({ params: params ?? {}, route: routeArg, timeoutMs })
        if (!create) throw Error('session.create is not configured in this harness')
        return create(routeArg, params ?? {})
      }
      if (method === 'session.title') {
        titles.push({ params: params ?? {}, route: routeArg, timeoutMs })
        if (!title) throw Error('session.title is not configured in this harness')
        return title(routeArg, params ?? {})
      }
      if (method === 'session.history') {
        histories.push({ params: params ?? {}, route: routeArg, timeoutMs })
        if (!history) throw Error('session.history is not configured in this harness')
        return history(routeArg, params ?? {})
      }
      throw Error(`Forbidden RPC: ${method}`)
    },
    openSession: async (storedId, options = {}) => {
      opens.push({ options, storedId })
      if (!openSession) throw Error('openSession is not configured in this harness')
      return openSession(storedId, options)
    }
  }, {
    get(target, key) {
      if (typeof key !== 'symbol') hostAccesses.push(key)
      if (!(key in target)) throw Error(`Forbidden host access: ${String(key)}`)

      return target[key]
    }
  })
  const sdk = { host, COMPOSER_AREAS: { leading: 'composer.leading' } }
  // Symbolic SDK colors make delegation observable without copying the native palette.
  sdk.profileColor = profile => `var(--mock-profile-${Array.from(profile, char => char.codePointAt(0).toString(16)).join('-')})`
  sdk.profileColorSoft = (color, opacity) => `color-mix(in srgb, ${color} ${opacity}%, transparent)`
  sdk.useValue = atom => {
    const [value, setValue] = hooks.useState(() => atom.get())
    hooks.useEffect(() => {
      let subscribing = true
      const stop = atom.subscribe(next => {
        setValue(next)
        // Updates after subscription re-render without a manual h.render().
        if (!subscribing && mounted) render()
      })
      subscribing = false
      return stop
    }, [atom])
    return value
  }
  for (const name of ['Button', 'Codicon', 'Tip', 'DropdownMenu', 'DropdownMenuTrigger', 'DropdownMenuContent', 'DropdownMenuItem', 'Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle']) sdk[name] = `sdk.${name}`
  sdk.useQuery = options => {
    const state = hooks.useRef({ data: undefined, error: null, isPending: true, isFetching: false })
    const opts = hooks.useRef(options)
    opts.current = options
    const refetch = async () => {
      const s = state.current
      const request = (s.request ?? 0) + 1
      s.request = request
      s.isFetching = true
      try {
        const data = await opts.current.queryFn({ signal: new AbortController().signal })
        if (request === s.request) Object.assign(s, { data, error: null, isPending: false })
      } catch (error) {
        if (request === s.request) Object.assign(s, { error, isPending: false })
      } finally { if (request === s.request) s.isFetching = false }
      return { data: s.data, error: s.error }
    }
    hooks.useEffect(() => { if (options.enabled !== false) void refetch() }, [options.enabled])
    return { ...state.current, refetch }
  }
  if (missing?.startsWith('state.')) delete state[missing.slice(6)]
  else if (missing?.startsWith('host.')) host[missing.slice(5)] = undefined
  else if (missing === 'leading') sdk.COMPOSER_AREAS = {}
  else if (missing?.startsWith('React.')) hooks[missing.slice(6)] = undefined
  else if (missing) delete sdk[missing]
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const runtime = { jsx, jsxs: jsx }
  const context = vm.createContext({ console, AbortController, crypto })
  const entry = new vm.SourceTextModule(await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8'), { context })
  await entry.link(specifier => {
    const data = { '@hermes/plugin-sdk': sdk, react: hooks, 'react/jsx-runtime': runtime }[specifier]
    assert.ok(data, `Unsupported runtime import ${specifier}`)
    return new vm.SyntheticModule(Object.keys(data), function () {
      for (const [key, value] of Object.entries(data)) this.setExport(key, value)
    }, { context })
  })
  await entry.evaluate()
  const ctx = new Proxy({
    register: contribution => { contributions.push(contribution); return () => {} },
    onDispose: fn => disposers.push(fn)
  }, {
    get(target, key) {
      if (typeof key !== 'symbol') ctxAccesses.push(key)
      if (!(key in target)) throw Error(`Forbidden context access: ${String(key)}`)

      return target[key]
    }
  })
  entry.namespace.default.register(ctx)
  const render = () => {
    cursor = 0
    tree = contributions[0]?.render?.()
    if (typeof tree?.type === 'function') {
      renderFn = tree.type
      tree = renderFn(tree.props)
    }
    while (effects.length) effects.shift()()
    return tree
  }
  const nodes = () => {
    const result = []
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node && typeof node === 'object') { result.push(node); walk(node.props?.children) }
    }
    walk(tree)
    return result
  }
  const find = type => nodes().find(node => node.type === `sdk.${type}`)
  const items = () => nodes().filter(node => node.type === 'sdk.DropdownMenuItem')
  const descendants = (root, type) => {
    const result = []
    const walk = node => {
      if (Array.isArray(node)) {
        node.forEach(walk)

        return
      }

      if (node && typeof node === 'object') {
        if (node.type === type || node.type === `sdk.${type}`) result.push(node)
        walk(node.props ? node.props.children : undefined)
      }
    }
    walk(root)

    return result
  }
  const within = (root, type) => descendants(root, type)[0]
  // Recursion never falls back to the tree root: an explicit undefined child
  // yields '' instead of restarting the walk.
  const renderText = node => {
    if (Array.isArray(node)) return node.map(renderText).join(' ')
    if (node && typeof node === 'object') return renderText(node.props ? node.props.children : undefined)

    return node == null ? '' : String(node)
  }
  const text = (node = tree) => renderText(node)
  // The stage-2 handoff dialog is an SDK Dialog that lives outside the menu.
  const dialog = () => find('Dialog')
  const dialogOpen = () => Boolean(dialog()?.props?.open)
  const dialogAction = label => {
    assert.ok(dialogOpen(), `the dialog must be open to click "${label}"`)
    const button = nodes().find(node => node.type === 'sdk.Button' && renderText(node) === label)
    assert.ok(button, `the dialog must offer a "${label}" action`)

    return button
  }
  // Escape/backdrop/X: Radix routes all three through the Dialog's onOpenChange.
  const dismissDialog = () => {
    const node = dialog()
    assert.ok(node, 'the dialog must be rendered')
    node.props.onOpenChange(false)
    render()
  }
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); render() }
  const open = async () => {
    render()
    assert.ok(find('DropdownMenu'), 'Picker must register an SDK DropdownMenu')
    find('DropdownMenu').props.onOpenChange(true)
    render()
    await settle()
  }
  const select = item => item.props.onSelect({ preventDefault() {} })
  return {
    calls, notices, contributions, sdk, focus, render, nodes, find, items, within, text, settle, open, select,
    dialog, dialogOpen, dialogAction, dismissDialog,
    get stateAccesses() { return [...new Set(stateAccesses)] },
    get hostAccesses() { return [...new Set(hostAccesses)] },
    get ctxAccesses() { return [...new Set(ctxAccesses)] },
    get persisted() { return persisted },
    get rpcCalls() { return rpcCalls },
    get creates() { return creates },
    get titles() { return titles },
    get opens() { return opens },
    get treeCalls() { return treeCalls },
    get histories() { return histories },
    // The entry's own named exports, as the real loader would see them.
    get namespace() { return entry.namespace },
    reader(fn) { reader = fn },
    registerAgain() {
      for (const fn of disposers) fn()
      for (const slot of slots) slot?.cleanup?.()
      slots.length = contributions.length = disposers.length = 0
      entry.namespace.default.register(ctx)
      render()
    },
    get tree() { return tree },
    get reads() { return reads }, get listReads() { return listReads },
    dispose() { for (const fn of disposers) fn(); mounted = false; for (const slot of slots) slot?.cleanup?.() },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.() },
    // React StrictMode's mount/unmount/mount probe: effects clean up and run
    // again on the SAME instance (state and refs survive).
    remount() {
      for (const slot of slots) slot?.cleanup?.()

      for (const key of Object.keys(slots)) {
        if (slots[key]?.deps) delete slots[key]
      }

      return render()
    },
    get queryOptions() { return slots.find(s => s?.current?.queryFn)?.current }
  }
}
