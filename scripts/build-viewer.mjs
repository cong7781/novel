/**
 * Build a self-contained page from the last extracted graph.
 *
 * Output: out/character-graph.html — data AND d3 inlined, no server, no network.
 * Double-click it, or open it with the default browser.
 *
 * Usage: node scripts/build-viewer.mjs [data.json] [out.html]
 */

import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { reasonLabel } from '../lib/extract.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataPath = resolve(root, process.argv[2] ?? 'out/latest-graph.json')
const outPath = resolve(root, process.argv[3] ?? 'out/character-graph.html')

const data = JSON.parse(await readFile(dataPath, 'utf8'))

// The page footer shows which version built it, so a screenshot can be dated against the changelog.
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version ?? '0.0.0'

const bundle = await buildBundle()

const script = bundle.text
const stats = data.stats ?? {}
const stamp = Date.now().toString(36)
const droppedReasons = (stats.droppedReasons ?? [])
  .map((item) => `${reasonLabel(item.reason)} ${item.count} 条`)
  .join('、')
const droppedNote =
  stats.dropped > 0
    ? `<span class="warn">${stats.dropped} 条边被丢弃（${droppedReasons || '无明细'}）；图上只画通过逐字校验的边。</span>`
    : ''

const STATS_HINT = `≤ 600,000 字；超过 8,000 字自动分块，超过 5 万字走检索式抽取`

// A 155-character cast cannot be read at any zoom; the page draws the main cast and lets the reader
// ask for the rest. The option list comes from the data, so a 9-person graph offers no cut at all.
const totalNodes = (data.nodes ?? []).length
const visiblePresets = [20, 40, 80].filter((n) => n < totalNodes).concat(totalNodes)
const visibleDefault = totalNodes > 40 ? 40 : totalNodes
const visibleOptions = visiblePresets
  .map(
    (n) =>
      `<option value="${n}"${n === visibleDefault ? ' selected' : ''}>` +
      `${n === totalNodes ? `全部（${n}）` : `${n} 人`}</option>`,
  )
  .join('')

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>角色关系网 · ${escapeHtml(String(data.source?.name ?? '文本'))} · ${stamp}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #06080f;
    --text: #e9edf6;
    --muted: #94a2ba;
    --panel: rgba(255, 255, 255, 0.045);
    --panel-strong: rgba(255, 255, 255, 0.075);
    --line: rgba(255, 255, 255, 0.1);
    --accent: #6f9bff;
    --accent-2: #b98cff;
    --shadow: 0 30px 70px -38px rgba(0, 0, 0, 0.95);
  }
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #edf1f8;
    --text: #101828;
    --muted: #5b6779;
    --panel: rgba(255, 255, 255, 0.72);
    --panel-strong: rgba(255, 255, 255, 0.92);
    --line: rgba(18, 30, 60, 0.12);
    --accent: #3f6fd6;
    --accent-2: #8b5cf6;
    --shadow: 0 30px 70px -40px rgba(30, 45, 80, 0.4);
  }

  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0; padding: 34px 32px 64px;
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: var(--text);
    background: var(--bg);
    overflow-x: hidden;
  }
  /* ── backdrop: drifting aurora + grain ───────────────────────────────────────────── */
  .aurora { position: fixed; inset: -20vmax; z-index: -2; pointer-events: none; filter: blur(70px); opacity: .75; }
  .aurora i {
    position: absolute; display: block; border-radius: 50%;
    mix-blend-mode: screen;
  }
  html[data-theme="light"] .aurora { opacity: .55; filter: blur(80px); }
  html[data-theme="light"] .aurora i { mix-blend-mode: multiply; }
  .a1 { width: 46vmax; height: 46vmax; left: 4vmax; top: -6vmax; background: radial-gradient(circle, rgba(88,124,255,.85), rgba(88,124,255,0) 70%); animation: drift1 26s ease-in-out infinite alternate; }
  .a2 { width: 40vmax; height: 40vmax; right: -2vmax; top: 6vmax; background: radial-gradient(circle, rgba(219,80,180,.55), rgba(219,80,180,0) 70%); animation: drift2 31s ease-in-out infinite alternate; }
  .a3 { width: 52vmax; height: 52vmax; left: 22vmax; bottom: -22vmax; background: radial-gradient(circle, rgba(60,220,200,.45), rgba(60,220,200,0) 70%); animation: drift3 37s ease-in-out infinite alternate; }
  @keyframes drift1 { from { transform: translate3d(-4%, -2%, 0) scale(1); } to { transform: translate3d(9%, 6%, 0) scale(1.15); } }
  @keyframes drift2 { from { transform: translate3d(3%, 4%, 0) scale(1.05); } to { transform: translate3d(-8%, -5%, 0) scale(.92); } }
  @keyframes drift3 { from { transform: translate3d(0, 4%, 0) scale(.95); } to { transform: translate3d(-6%, -8%, 0) scale(1.12); } }
  .grain {
    position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: .05;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
    mix-blend-mode: overlay;
  }

  /* ── layout ──────────────────────────────────────────────────────────────────────── */
  /* The graph is the page: a wide frame, and everything technical lives underneath it. */
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  h1 {
    margin: 0 0 4px; font-size: 22px; letter-spacing: .02em; font-weight: 700;
    background: linear-gradient(100deg, #dbe6ff 0%, var(--accent) 38%, var(--accent-2) 72%, #7fe6d6 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  html[data-theme="light"] h1 { background: linear-gradient(100deg, #1c2f5c, var(--accent) 45%, var(--accent-2)); -webkit-background-clip: text; background-clip: text; }
  .stats { color: var(--muted); font-size: 12.5px; }
  .warn { display: block; margin-top: 6px; color: #f0a35e; font-size: 12.5px; }
  .muted { color: var(--muted); }
  #theme {
    flex: none; width: 34px; height: 34px; border-radius: 10px; cursor: pointer;
    background: var(--panel); border: 1px solid var(--line); color: var(--text);
    font-size: 15px; line-height: 1; transition: transform .2s ease, background .2s ease;
  }
  #theme:hover { transform: translateY(-1px) rotate(-8deg); background: var(--panel-strong); }

  .glass {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
  }

  /* ── upload ─────────────────────────────────────────────────────────────────────── */
  #upload { padding: 12px 14px; margin-bottom: 14px; }
  #upload form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  #upload input[type=file] { font-size: 12.5px; color: var(--muted); }
  #upload input[type=file]::file-selector-button {
    margin-right: 10px; padding: 6px 12px; border-radius: 9px; cursor: pointer;
    font: inherit; font-size: 12.5px; color: var(--text);
    background: var(--panel-strong); border: 1px solid var(--line);
    transition: background .2s ease, transform .2s ease;
  }
  #upload input[type=file]::file-selector-button:hover { transform: translateY(-1px); }
  #upload button[type=submit] {
    padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    color: #fff; border: 0; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 8px 22px -12px rgba(111, 155, 255, .9);
    transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease;
  }
  #upload button[type=submit]:hover { transform: translateY(-1px); box-shadow: 0 12px 26px -12px rgba(111, 155, 255, 1); }
  #upload button[type=submit]:disabled { opacity: .5; cursor: default; transform: none; }
  #upload-status { color: var(--muted); font-size: 12px; }
  #upload textarea {
    flex: 1 1 100%; min-height: 56px; resize: vertical; padding: 8px 10px;
    font: inherit; font-size: 12.5px; color: var(--text);
    background: rgba(0, 0, 0, .16); border: 1px solid var(--line); border-radius: 10px;
    transition: border-color .2s ease;
  }
  html[data-theme="light"] #upload textarea { background: rgba(255, 255, 255, .6); }
  #upload textarea:focus { outline: none; border-color: var(--accent); }
  #upload select, #upload input[type=number] {
    padding: 6px 9px; border-radius: 9px; font: inherit; font-size: 12.5px; color: var(--text);
    background: var(--panel-strong); border: 1px solid var(--line);
  }
  #upload input[type=number] { width: 108px; }
  #runs { max-width: 360px; }

  /* ── graph ───────────────────────────────────────────────────────────────────────── */
  #graph {
    position: relative; padding: 8px; border-radius: 20px;
    background:
      radial-gradient(120% 90% at 50% -10%, rgba(111, 155, 255, .16), transparent 62%),
      var(--panel);
    border: 1px solid var(--line);
    box-shadow: var(--shadow), inset 0 1px 0 rgba(255, 255, 255, .07);
    backdrop-filter: blur(16px);
    overflow: hidden;
  }
  html[data-theme="light"] #graph { background: radial-gradient(120% 90% at 50% -10%, rgba(111, 155, 255, .18), transparent 62%), var(--panel); }
  #legend-slot:empty { display: none; }
  #legend-slot { margin: 12px 0 2px; }

  /* ── evidence ────────────────────────────────────────────────────────────────────── */
  #evidence { margin-top: 14px; }
  .hint { color: var(--muted); font-size: 12.5px; margin: 0 0 8px; }
  .row {
    padding: 9px 13px 11px 13px; margin-bottom: 10px; border-radius: 12px;
    border-left: 3px solid var(--accent);
    background: var(--panel); border-top: 1px solid var(--line);
    border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  }
  .quote { font-size: 13.5px; color: var(--text); opacity: .86; margin-top: 4px; line-height: 1.75; }
  .tag {
    display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px;
    background: rgba(111, 155, 255, .16); color: var(--accent);
  }

  /* ── technical block (below the graph) ───────────────────────────────────────────── */
  #technical { margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line); }
  .section-title {
    margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .08em;
    text-transform: uppercase; color: var(--muted);
  }
  #technical-tools {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    padding: 12px 16px; margin-bottom: 14px;
  }
  #technical-tools .label { font-size: 12.5px; color: var(--muted); }
  #technical-tools select {
    padding: 6px 9px; border-radius: 9px; font: inherit; font-size: 12.5px; color: var(--text);
    background: var(--panel-strong); border: 1px solid var(--line);
  }

  /* ── run stats ───────────────────────────────────────────────────────────────────── */
  #run-stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 4px 12px; padding: 14px 16px; margin-bottom: 14px;
  }
  .cg-metric { padding: 4px 2px; }
  .cg-metric-key { font-size: 11px; color: var(--muted); letter-spacing: .02em; }
  .cg-metric-value {
    font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums;
    letter-spacing: -.01em;
  }
  .cg-notes {
    grid-column: 1 / -1; margin: 10px 0 0; padding-left: 18px;
    font-size: 12px; line-height: 1.65; color: var(--muted);
  }
  .cg-notes li { margin-top: 3px; }

  /* ── progress ────────────────────────────────────────────────────────────────────── */
  #progress { padding: 11px 16px 12px; margin-bottom: 14px; }
  #progress .bar { height: 6px; border-radius: 999px; background: rgba(255, 255, 255, .1); overflow: hidden; }
  html[data-theme="light"] #progress .bar { background: rgba(18, 30, 60, .1); }
  #progress .bar i {
    display: block; height: 100%; width: 0;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width .45s cubic-bezier(.4, 0, .2, 1);
  }
  #progress .labels {
    display: flex; justify-content: space-between; gap: 14px; margin-top: 8px;
    font-size: 12px; color: var(--muted);
  }

  /* ── legend ─────────────────────────────────────────────────────────────────────── */
  .cg-legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 auto 12px; }
  .cg-legend span {
    display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px;
    font-size: 11.5px; color: var(--muted); border-radius: 999px;
    background: var(--panel); border: 1px solid var(--line);
  }
  .cg-legend i { width: 14px; height: 3px; border-radius: 2px; display: inline-block; box-shadow: 0 0 8px currentColor; }
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><i class="a1"></i><i class="a2"></i><i class="a3"></i></div>
<div class="grain" aria-hidden="true"></div>

<div class="wrap">
  <header>
    <div>
      <h1>角色关系网 <span style="font-size:11px;color:var(--muted);font-weight:400;letter-spacing:0">v${escapeHtml(version)} · build ${stamp} · <a href="https://github.com/cong7781/novel/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer" style="color:var(--muted);text-decoration:none;border-bottom:1px dotted currentColor">更新日志</a></span></h1>
      <div class="stats" id="stats">
        ${stats.nodes ?? data.nodes.length} 个角色 · ${stats.edges ?? data.edges.length} 条关系 ·
        ${escapeHtml(String(data.source?.name ?? '文本'))}${stats.chars ? `（${stats.chars} 字）` : ''}
      </div>
    </div>
    <button id="theme" type="button" title="切换深浅色" aria-label="切换深浅色">◐</button>
  </header>

  <section id="upload" class="glass">
    <form>
      <input type="file" accept=".txt,.md,.markdown,text/plain" aria-label="选择文本文件">
      <button type="submit">生成关系网</button>
      <select id="mode" aria-label="抽取模式">
        <option value="auto">自动</option>
        <option value="rag">检索式（RAG）</option>
        <option value="chunk">全量分块</option>
        <option value="single">单次调用</option>
      </select>
      <input id="budget" type="number" min="1" placeholder="预算块数" aria-label="最多精细抽取多少块">
      <span id="upload-status">选一个 txt，或把文本粘到下面（${STATS_HINT}）</span>
      <textarea placeholder="把小说片段粘到这里…"></textarea>
    </form>
  </section>

  <div id="progress" class="glass" hidden>
    <div class="bar"><i></i></div>
    <div class="labels"><span id="progress-label">准备中…</span><span id="progress-detail"></span></div>
  </div>

  <div id="graph" class="glass"></div>
  <div id="legend-slot"></div>
  <div id="evidence"></div>

  <!-- Everything technical lives below the graph: the page opens with the paste box and the graph. -->
  <section id="technical">
    <div class="section-title">运行与技术信息</div>
    <div id="technical-tools" class="glass">
      <span class="label">历史产物</span>
      <select id="runs" aria-label="载入历史产物"><option value="">（载入一次之前的运行）</option></select>
      <span class="label">显示</span>
      <select id="visible-count" aria-label="显示多少个角色">${visibleOptions}</select>
      <span class="label">切到某次运行就能看到它的图、成本与证据；不会重新调用模型。</span>
    </div>
    ${droppedNote ? `<div class="glass" style="padding:11px 16px;margin-bottom:14px">${droppedNote}</div>` : ''}
    <section id="run-stats" class="glass"></section>
  </section>
</div>

<script>
  (function () {
    var root = document.documentElement
    var saved = null
    try { saved = localStorage.getItem('cg-theme') } catch (e) {}
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved
    document.getElementById('theme').addEventListener('click', function () {
      var next = root.dataset.theme === 'light' ? 'dark' : 'light'
      root.dataset.theme = next
      try { localStorage.setItem('cg-theme', next) } catch (e) {}
    })
  })()
</script>
<script>window.__GRAPH_DATA__ = ${JSON.stringify(data)};</script>
<script>${script}</script>
</body>
</html>
`

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, html, 'utf8')
console.log(`wrote ${outPath} (${(html.length / 1024).toFixed(1)} KiB)`)
console.log(`  ${data.nodes.length} nodes / ${data.edges.length} edges / ${stats.chars} chars`)

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}

/**
 * Bundle the viewer.
 *
 * esbuild is the normal route: one minified file, tree-shaken. It is a native service that talks to
 * the JavaScript side over stdio pipes, and a confined sandbox forbids exactly that (`spawn EPERM`),
 * so a refused spawn falls back to concatenating the same sources by hand — the d3-force UMD build
 * (which installs `globalThis.d3`), then `src/highlight.js` with its `export` keywords stripped, then
 * `scripts/viewer/app.js` with its two import lines dropped. Everything shares one function scope,
 * so the names resolve exactly as they did under the bundler; the page stays self-contained either
 * way, just larger.
 */
async function buildBundle() {
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ['scripts/viewer/app.js'],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      minify: true,
      legalComments: 'none',
      logLevel: 'warning',
    })
    return { text: result.outputFiles[0].text, via: 'esbuild' }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!/\bEPERM\b|spawn|ENOENT/.test(message)) throw error
    console.warn(`esbuild 无法启动（${message.split('\n')[0]}），改用内联拼接打包`)
    return { text: await bundleWithoutEsbuild(), via: 'inline' }
  }
}

async function bundleWithoutEsbuild() {
  const [d3, highlight, app] = await Promise.all([
    readFile(resolve(root, 'node_modules/d3-force/dist/d3-force.min.js'), 'utf8'),
    readFile(resolve(root, 'src/highlight.js'), 'utf8'),
    readFile(resolve(root, 'scripts/viewer/app.js'), 'utf8'),
  ])
  const highlightBody = highlight.replace(/^export\s+(?=(?:const|let|var|function|class)\b)/gm, '')
  const appBody = app.replace(/^import\s[^\n]*\n/gm, '')
  return [
    '(function () {',
    '// d3-force UMD build: installs globalThis.d3 when no module system is present.',
    d3,
    'const { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } = globalThis.d3;',
    highlightBody,
    appBody,
    '})();',
  ].join('\n')
}
