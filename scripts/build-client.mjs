/**
 * Build the browser half into lib/client.js.
 *
 * The DSH web boot evaluates client bundles as `window.__ModuleLoader__.load({ id, factory })`
 * and hands the factory a `require` that only resolves `react` / `react-dom`. Everything else
 * must be inlined, which is what esbuild is doing here; the wrapper below is the only part of
 * the output that must match the host contract.
 */

import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client.jsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: ['react', 'react-dom'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})

const bundle = result.outputFiles[0].text

const indented = bundle
  .split('\n')
  .map((line) => (line === '' ? line : `\t\t${line}`))
  .join('\n')

const output = `/* ${pkg.name} client half. Built by scripts/build-client.mjs — do not edit by hand. */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t},
});
`

const target = resolve(root, 'lib/client.js')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, output, 'utf8')

console.log(`built ${target} (${(output.length / 1024).toFixed(1)} KiB)`)
