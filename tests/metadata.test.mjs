// Narrow scalar contracts only; Hermes validates the actual YAML schema separately.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(await read('package.json'))
const manifest = await read('plugin.yaml')
const entry = await read('desktop/plugin.js')
const license = await read('LICENSE')
const repo = 'https://github.com/Vsemagush/hermes-profile-switcher'

// Deliberately supports only this manifest's plain or double-quoted single-line scalars.
function scalar(key, expected) {
  const lines = manifest.split(/\r?\n/).filter(line => line.startsWith(`${key}:`))
  assert.equal(lines.length, 1, `exactly one top-level ${key}`)
  const value = lines[0].slice(key.length + 1).trim()
  assert.ok(value === expected || value === JSON.stringify(expected), `${key} must be ${expected}; got ${value}`)
}

test('metadata: package, manifest and Desktop entry share the public identity', () => {
  assert.equal(pkg.name, 'hermes-profile-switcher')
  scalar('name', pkg.name)
  scalar('author', 'Vsemagush')
  scalar('kind', 'standalone')
  assert.equal(entry.match(/^const PLUGIN_ID = '([^']+)'$/m)?.[1], pkg.name)
  assert.ok(/export default \{\s+id: PLUGIN_ID,/.test(entry), 'Desktop export uses the shared plugin id')
})

test('metadata: Desktop display name matches the public product name', () => {
  assert.equal(entry.match(/export default \{\s+id: PLUGIN_ID,\s+name: '([^']+)'/)?.[1], 'Hermes Profile Switcher')
})

test('metadata: tooling and manifest versions match the initial product version', () => {
  assert.equal(pkg.version, '0.1.0')
  scalar('version', pkg.version)
})

test('metadata: conservative supported Hermes floor is declared', () => {
  scalar('requires_hermes', '>=0.22.2')
})

test('metadata: tooling stays private rather than enabling npm publication', () => {
  assert.equal(pkg.private, true)
})

test('metadata: package and manifest declare the shipped MIT license', () => {
  assert.equal(pkg.license, 'MIT')
  scalar('license', pkg.license)
  assert.match(license, /^MIT License\r?\n/)
})

test('metadata: repository and homepages identify only the public repository', () => {
  assert.deepEqual(pkg.repository, { type: 'git', url: `${repo}.git` })
  assert.equal(pkg.homepage, repo)
  scalar('homepage', repo)
})
