# 发布与安装

这份文档是给**仓库维护者**看的：怎么把插件发到 GitHub（可选再发到 npm），以及别人装进去之后到底能不能直接用。

## 0. 首次发布前要改的三个占位符

| 文件 | 改什么 |
|---|---|
| `LICENSE` | `cong7781` → 你的名字或组织名 |
| `package.json` | `cong7781`（`repository` / `homepage` / `bugs` 三处）、`author` |
| `package.json` | `version`：当前 `0.2.0`；之后每次发版按语义化版本改 |

`package.json` 里刻意**没有**声明 `@deepseek-ai/*` 的 `peerDependencies`：本插件只用到
`ctx.tools` / `ctx.llm` / `ctx.agentDefaultModel` 和 `tool.call.toolview` 座位，这些在 0.2.x 上稳定；
一旦写死 peer 范围，别人装的时候会因为 DSH 小版本差异被兼容性检查直接拒掉。代价是
**兼容性检查不会替你兜底**，所以 README 里要写清测过哪个版本（当前：DSH Desktop 0.2.0-rc.2 / node 24）。

## 1. 建仓库并推上去

```bash
cd dsh-character-graph        # 本目录就是仓库根，package.json 在根上
git init
git add .
git commit -m "feat: character graph with chunked RAG extraction (0.2.0)"
git branch -M main
git remote add origin https://github.com/cong7781/novel.git
git push -u origin main
```

推之前先自查三件事：

```bash
git status --short          # node_modules/ 与 out/ 必须是 ignored，不能出现在列表里
npm test                   # 四套离线断言全绿（highlight / host / pipeline / client）
git grep -nE "sk-[A-Za-z0-9]{16,}" -- . ':!pnpm-lock.yaml'   # 仓库里不能有 key
```

`.gitignore` 已经排除 `node_modules/`、`out/`（运行产物、构建页、截图原图）、日志与编辑器目录。
`pnpm-lock.yaml` 要提交（CI 用 `--frozen-lockfile`）；本机没有 pnpm 时用 `npm install` 也能装 devDependencies。

想直接用 GitHub 网页建仓库也可以，但**不要**勾「Add a README / .gitignore / LICENSE」——
本地已经有了，会让 `git push` 冲突。

打 tag 与 Release（可选，但 GitHub 上看着正规）：

```bash
git tag -a v0.2.0 -m "0.2.0"
git push origin v0.2.0
```

Release 描述里贴 `docs/screenshots/600k-overview.png` 与 `docs/screenshots/600k-pair.png` 两张图就够了。

## 2. 别人怎么装（DSH 侧）

DSH 的插件安装支持四种 spec（见 DSH 自带 `dsh-plugin-manager` 文档）：**registry 包名**、
**绝对路径**、**git 地址**、**tarball**。所以 GitHub 仓库可以直接装，不必先发 npm：

```text
github:cong7781/novel        # git 简写
https://github.com/cong7781/novel   # 完整 URL
dsh-character-graph                                  # 发过 npm 之后
D:\code\dsh-character-graph                          # 本地目录（开发用）
```

用 GitHub 地址时，DSH 在跑 pnpm 之前会先 `git ls-remote` 探一次仓库：
GitHub 不通、私有库没凭据，会**在改动 profile 之前**失败，不会留下半装状态。
git / tarball spec 的版本兼容性检查发生在装完之后（失败会回滚 manifest 与 lockfile）。

安装入口有两个：

- **网页侧边栏 → 插件页**：粘贴 spec、装、启用/停用、取消选择组合包；
- **对话里 `plugin_manager` 工具**（Creator 模式默认启用）：效果一样。

权限：每个插件操作都需要 `danger-full-access` 或本次调用的批准；pnpm 拦下依赖构建脚本时还要单独批准
（本插件**没有任何 `postinstall`/`prepare` 构建脚本**，正常不会遇到这一步）。

装完的状态：新组合包**默认启用**，写进 profile 的 `package.json` 与 `cordis.patch.yml`，
HMR 开着时立刻生效；`lib/index.js` 是宿主代码，若对方关掉了 HMR 或 DSH 缓存了旧模块，**重启一次 DSH** 才稳。

## 3. 别人装完能直接用吗？

**能，但只限「对话内」这一半。** 三个前提：

1. 对方的 DSH 里**配置了默认模型**（`ctx.agentDefaultModel`）。抽取走的就是这个模型，不需要任何 API key；
2. DSH 版本兼容（当前验证到 0.2.0-rc.2）；
3. 文本是中文叙事、且不超过 60 万字。

装完就有：

- `extract_characters` 工具：`text` / `path` 二选一，不传就用自带的 8.8k 测试文本；
- 对话里的关系图卡片（`tool.call.toolview` 座位，`lib/client.js` 预构建，安装时不需要装 d3）；
- 12 个角色 / 198 条边那种规模的图、两次点击看两人情节、`?pair=` 深链；
- 证据闸门与丢弃计数（卡片上直接写丢弃原因）。

**装完没有**（这些在仓库里，不在 npm 包里）：

- 命令行 `scripts/extract-cli.mjs`（可续跑的长文本流水线）；
- 独立查看器 `scripts/serve.mjs` + `out/character-graph.html`（进度条、成本面板、原文检索、历史产物）；
- `scripts/make-longtext.mjs` / `eval-graph.mjs` / `compare-graphs.mjs`。

原因：查看器要用 `esbuild` 构建页面，还要一枚 DeepSeek key（`DEEPSEEK_API_KEY` 或
`~/.dsh/.credentials.yaml`），把这两样塞进安装包不合适。想让别人也能用查看器，让他们：

```bash
git clone https://github.com/cong7781/novel.git
cd dsh-character-graph
npm install                        # 只装 devDependencies：d3-force + esbuild（相当于 pnpm install）
node scripts/extract-cli.mjs --path fixtures/sample.txt --out out/runs/demo
node scripts/build-viewer.mjs out/runs/demo/result.json out/character-graph.html
node scripts/serve.mjs             # http://127.0.0.1:19401
```

> 如果希望**安装包本身**就带查看器，需要三处改动：`files` 加 `scripts/`、把 `esbuild` 从
> `devDependencies` 移到 `dependencies`、再加一个 `bin` 入口。代价是安装时多下 ~10MB 依赖，
> 而绝大多数人只需要对话内那张图，所以默认没这么做。

## 4. 发到 npm（可选）

npm 上的名字先到先得，`dsh-character-graph` 若已被占用，改成 `@你的scope/dsh-character-graph`
（`package.json` 的 `name` 与安装 spec 一起改）：

```bash
npm login
npm pack --dry-run        # 先看 payload：应该只有 lib/ locale/ fixtures/ icon.svg cordis.patch.yml + README/LICENSE
npm publish --access public
```

`package.json` 里的 `files` 已经限定好，`private` 已移除。发布后装法变成一行 `dsh-character-graph`，
DSH 的 `inspect()` 会先 `pnpm view` 查注册表（默认先官方源，再 `registry.npmmirror.com` 兜底）。

## 5. 发版检查清单

- [ ] `npm install && npm test` 全绿；
- [ ] `npm run build` 之后 `lib/client.js` 没有 diff（预构建产物与源码一致）；
- [ ] `npm pack --dry-run` 的文件列表符合预期，没有 `scripts/`、没有 `out/`、没有 key；
- [ ] `README.md` 里的截图路径（`docs/screenshots/…`）都存在；
- [ ] `version` 改过、`git tag` 与 `CHANGELOG`（如果有）对齐；
- [ ] 在**另一台机器/另一个 profile** 上真装一次：装完调用一次 `extract_characters()`，看到卡片出图。

## 6. 会翻车的地方

| 风险 | 表现 | 处理 |
|---|---|---|
| GitHub 不可达 | 安装前 `git ls-remote` 超时，报 spec-host 失败 | 换本地目录或 npm spec；不要重试同一条 GitHub 地址 |
| DSH 版本不兼容 | 若将来声明了 peer，安装前直接被拒；现在没有声明，靠 README 声明测试版本 | 在 issue 里附 `DSH 版本 + node 版本 + 报错` |
| 宿主模块缓存 | 重装后卡片还是旧的 | 重启 DSH（Cordis ESM 缓存） |
| Windows 专用脚本 | `启动关系网.cmd` / `打开关系网.cmd` 在 macOS/Linux 不工作 | 用 `node scripts/serve.mjs` / `build-viewer.mjs` 替代 |
| 查看器端口未鉴权 | 任何本机进程都能用那枚 key 跑抽取 | 只监听 127.0.0.1，别转发端口 |
| npm 包名被占 | `npm publish` 403 | 改成 scope 包 `@you/dsh-character-graph` |
