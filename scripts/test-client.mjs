/**
 * Smoke test for the built browser bundle, without a browser.
 *
 * It answers the three questions that can actually break the card: does the bundle load
 * through the DSH module-loader contract, does apply() register the Tool view on the right
 * slot and key, and does the view fail soft when `block.meta` is missing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

// eslint-disable-next-line no-new-func
new Function('window', code)(fakeWindow)

assert.ok(captured, 'the bundle registers itself with the module loader')
assert.equal(captured.id, 'dsh-character-graph', 'the module id is the package name')

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
}
const moduleExports = captured.factory((name) => {
  assert.equal(name, 'react', 'only react may be required from the bundle')
  return react
})

assert.equal(typeof moduleExports.apply, 'function', 'exports.apply is provided')
assert.deepEqual(moduleExports.inject, ['slots'], 'exports.inject declares the slot registry')

const registrations = []
const ctx = {
  slots: {
    register(definition, component) {
      registrations.push({ definition, component })
      return () => {}
    },
    inject(name, callback) {
      assert.equal(name, 'tool.call.toolview', 'waits for the tool view slot to be declared')
      const disposers = [...callback()]
      return () => disposers.forEach((dispose) => dispose())
    },
  },
  effect(factory) {
    return factory()
  },
}

moduleExports.apply(ctx)

assert.equal(registrations.length, 1, 'exactly one view is registered')
assert.deepEqual(registrations[0].definition, {
  name: 'tool.call.toolview',
  key: 'extract_characters',
})
assert.equal(typeof registrations[0].component, 'function', 'the registered value is a component')

// The soft-failure path must not throw and must say something actionable.
const noMeta = registrations[0].component({
  phase: 'result',
  block: { isError: false, content: [], meta: null },
})
const noMetaRendered = typeof noMeta.type === 'function' ? noMeta.type(noMeta.props) : noMeta
assert.equal(noMetaRendered.type, 'div')
const text = JSON.stringify(noMetaRendered.children)
assert.ok(text.includes('不可还原'), 'a missing meta explains itself instead of rendering an empty box')

const errorView = registrations[0].component({
  phase: 'result',
  block: { isError: true, content: [{ type: 'text', text: '文本太短' }], meta: null },
})
const errorRendered = typeof errorView.type === 'function' ? errorView.type(errorView.props) : errorView
assert.ok(JSON.stringify(errorRendered.children).includes('文本太短'), 'tool errors are shown verbatim')

const pending = registrations[0].component({ phase: 'start', block: { call: { name: 'extract_characters' } } })
const pendingRendered = typeof pending.type === 'function' ? pending.type(pending.props) : pending
assert.ok(JSON.stringify(pendingRendered.children).includes('正在'), 'a running call says what is happening')

console.log('client ok')
