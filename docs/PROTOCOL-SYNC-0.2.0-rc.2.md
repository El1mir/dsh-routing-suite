# 协议同步审计：dsh-routing-suite × DSH 0.2.0-rc.2

> 本文件记录 `dsh-routing-suite` 三个组件（injector / preset / graded）从 DSH 旧接口写法**硬切**到 `0.2.0-rc.2` 现行协议的完整过程：为什么做、依据是哪一行、每个工单改了什么、怎么验证、还剩什么没做完。
> 全部「文件:行」断言均经逐行读取核实。路径一律相对**本仓库根**或**已安装 harness 根**（下文各自声明一次）。凡本文件无法在已安装版本上复现的断言，都在正文里标为「未能验证」，不作既成事实。

## 1. 背景与目标

### 1.1 为什么要硬切

本仓库三个组件都写过针对 DSH harness 的集成代码，而这些写法建立在**已经变化或从未存在**的接口之上。本次全盘审计把它们一次性切到 `0.2.0-rc.2` 的现行接口，**不保留向后兼容分支**：同时兼容两代协议会让"契约对不上"重新变成不可判定的问题，而本次审计的全部价值恰恰来自把这个不可判定问题变成可自动发现的。

### 1.2 共同根因：本地类型断言改写服务形状

工单集（`.scratch/protocol-sync/README.md:9`）把根因写得很准确：

> 共同根因是**用本地类型断言改写服务形状**：`ctx.get()` 返回 unknown，本地断言是唯一类型约束，于是契约对不上时 TypeScript 不报错，只在运行时暴露——而且因为外层普遍包着 `catch`，真实故障表现为"功能静默不生效"而不是报错。

这句话决定了本次施工的两个方向：

1. **消除断言**——凡"为了让类型通过而本地声明一个服务形状"的地方，都改成从 harness 的真实 `.d.ts` 导入真实类型；类型不存在就说明这条路本身不存在，必须换实现。
2. **建立守卫**——因为这类错误 TS 抓不到，必须另建一套针对 harness 权威面的静态检查。

### 1.3 两个目标

- **硬切**：injector / preset / graded 三个组件的装载声明、服务调用、资源注销、类型引用全部对齐 `0.2.0-rc.2`。
- **防漂移**：把 harness 权威接口固化成可执行守卫（`guard/`），使下一次 harness 升级导致的漂移在 CI 阶段就失败，而不是在用户会话里静默失效。

### 1.4 施工组织

工单集落在 `.scratch/protocol-sync/`：`README.md` 记目标与并行度，`issues/01-…12-….md` 是 12 个工单。仓库 tracker 是 GitHub `El1mir/dsh-routing-suite`，但本机 `gh` CLI 未安装，工单先以本地文件形式存在、格式与 GitHub issue 一致（`README.md:41`）。

工单本身**刻意不写路径与行号**——`README.md:7` 说明了理由：「那些会快速失效；证据留在文档里」。本文件就是那份证据。

## 2. 权威基准

本次审计涉及三个可能互相矛盾的"事实来源"。取舍规则如下，后文一切断言按此执行。

| 来源 | 位置 | 版本/规模 | 在本审计中的地位 |
| --- | --- | --- | --- |
| 已安装 harness | `C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\` | `0.2.0-rc.2` | **唯一权威基准**。契约以它的 `.d.ts` 与 `lib/index.js` 为准 |
| 源码 checkout | `C:\Users\Administrator\Videos\deepseek-harness` | `0.2.1-alpha.1`，无 `node_modules` | **只用于读语义**，解释"为什么这样设计"；不作为验收基准 |
| 可安装包清单 | 已安装 harness 根下 `node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md` | 242 条，sha256 `20d4c693baaca4b9952e78815b1763eaa325ecf147cfffc2d1546291f19eb2c1` | 判「某包名是否存在于本版本」的权威清单 |

### 2.1 三条取舍规则

1. **运行版本压倒一切。** checkout 是 `0.2.1-alpha.1`，比运行版本新，里面存在运行版本没有的包。任何"未来会怎样"的推论都不能写成"现在就是这样"。本文件中所有契约断言都以已安装版本为准。
2. **checkout 只能回答"为什么"。** 例如"为什么 `register()` 返回 disposer 而不是提供 `unregister()`"这类设计意图，可以从 checkout 的源码与注释读出；但"`unregister()` 存不存在"必须以已安装版本为准。
3. **`packages.md` 的第二列不是"可否安装"。** 该文件 `:1-11` 自述：标题为 `# Loadable Harness plugin packages`，由 `scripts/gen-plugin-packages.ts` 从 workspace manifests 生成、`pnpm run verify-plugin-packages` 校验、**不要手改**；`:5` 明确写「Every package below exports a Cordis plugin that a bundle patch can name in a Loader row. `Config` marks packages whose row accepts a `config` mapping」。表头是 `| Package | Config | Description |`（`:9`）。**能出现在这张表里 = 可安装；第二列的 `yes`/`no` 只表示该行接不接受 `config` 映射。** 把第二列读成"可否安装"是本次审计中纠正的一个真实误读。

### 2.2 本机环境事实（用于判断"某路径是否存在"）

- `DSH_HOME` = `C:\Users\Administrator\.dsh`（环境变量真实值）
- `USERPROFILE` = `C:\Users\Administrator`
- `C:\Users\Eldwen\.dsh` **不存在**；`C:\Users\Administrator\.dsh\.dsh` **不存在**；`C:\Users\Administrator\.dsh\.agent-presets` **不存在**
- 真实 profile 在 `C:\Users\Administrator\.dsh\profiles\web\`，含 `cordis.yml`（正文是注释加空数组 `[]`，注释指明树由 bundle patch 组合、"Edit cordis.patch.yml, not this file"）、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`

这两条不存在的路径在第 7 节会作为**实际缺陷**出现，不是背景知识。

## 3. 协议变化对照表

下表是本次审计的核心结论。harness 侧行号相对已安装 harness 根下的 `node_modules/@deepseek-ai/`；仓库侧相对本仓库根。

| # | 协议面 | 旧写法 | 新写法 | 依据（文件:行） |
| --- | --- | --- | --- | --- |
| 1 | 预设装载 | 往 `$DSH_HOME/.agent-presets/<id>/` 投目录，靠 `preset.yml` + `agent.cordis.yml` 被发现 | bundle 包 + 声明行：`package.json` 声明 `dsh.bundle.patch`，patch 里 `- insert:` 一行指向 `@deepseek-ai/dsh-agent-preset` 并给出完整 `config` | `preset/router-standard/bundle/package.json:20-24`；`preset/router-standard/bundle/cordis.patch.yml:20-28` |
| 2 | 客户端模块联动 | 直接改 `ClientModuleRegistry` 私有成员（清 `pkgMeta`、调 `processOne`） | 重发官方事件 `ctx.root.emit("internal/plugin", { entry: { options: { name } } })`，由官方 microtask flush 收敛 | `dsh-client-modules/lib/index.js:527-536`、`:791-793`、`:833`；`injector/src/index.ts:2234-2244`、`:2347-2364` |
| 3 | cordis 包名 | 裸名 `cordis` / `cosmokit` / `schemastery` | scoped 名 `@deepseek-ai/cordis` / `@deepseek-ai/cosmokit` / `@deepseek-ai/schemastery` | `package.json:70`；`injector/package.json:41`；`injector/src/index.ts:107-112`、`:4400` |
| 4 | 类型声明面 | 声明 `types` 指向一个构建根本不产出的路径 | 两条路各自正确：要么让构建**真的产出**声明，要么**删掉** `types` 字段 | `injector/tsconfig.json:9-10`（`declaration`+`declarationDir: lib/types`）；`graded/package.json`（无 `types` 字段）；`guard/contracts.mjs:466-470` |
| 5 | 工具注销 | 调 `ctx.tools.unregister(...)` 或直接删内部表 | 保留 `register()` 的返回值（就是 disposer），或把它挂到 `ctx.effect` 上 | `dsh-tools/lib/index.js:2876`、`:2878-2886`；`injector/src/index.ts:3230-3242`、`:3284-3308` |
| 6 | 副作用注销 | `ctx.on('dispose', cb)` | `ctx.effect(() => …, 'label')` | `graded/src/index.js:647-657`；守卫 `guard/contracts.mjs:83`（`cordis-event-names`） |

### 3.1 预设装载：目录协议确实已经死了

「旧目录协议已死」不是推测，是实测结论。在**整个已安装 harness 的 `node_modules/@deepseek-ai/**`**（`*.js` / `*.mjs` / `*.cjs` / `*.ts` / `*.d.ts`）里：

- 搜字面量 `.agent-presets`（带点）→ **0 命中**
- 搜 `preset.yml`（`*.js`）→ **0 命中**
- 搜 `agent-presets`（不带点）→ 6 处命中，**全部是插件名、UI 分组 id 或注释字符串**，无一处读取目录：
  - `dsh-agent-preset-registry/lib/types/invariant.d.ts:7`、`dsh-agent-preset-registry/lib/types/invariant.js:11`、`dsh-agent-preset-registry/lib/invariant.js:803` —— 三处都是 `const name = "agent-presets-invariant"`
  - `dsh-client-ui-agent-preset/lib/client.js:1687` —— `id: "agent-presets"`
  - `dsh-client-ui-settings-general/lib/client.js:253` —— `if (id === "agent-presets")`
  - `dsh-cordis-client-runner/lib/client.js:4751` —— 注释 `"client-ui-agent-preset AgentPresetSection id 'agent-presets'"`

替代路径是 bundle 声明行，形态见 `preset/router-standard/bundle/cordis.patch.yml:20-28`：`- insert:` 下 `id: preset-router-standard`、`name: "@deepseek-ai/dsh-agent-preset"`、`config` 里含 `id` / `name` / `description` / `order` / `plugins`。原 `preset.yml` 的四个字段（id / name / description / order）全部由这一行承接。

**决定施工方式的关键机制**（该 patch `:1-18` 头部注释原文记录）：`config` 在 insert 时是**整体替换、绝不深合并**，所以每个字段都必须重述。这一条直接决定了"覆盖既有预设时必须写全所有字段"，而不是只写差异项。

同一条注释还记录了两件事：相对行（如 `./router-bootstrap-v34.mjs?v=88`）**相对于 patch 文件自身所在目录解析**（`dsh-app-boot` 从 config file 的 URL 设 `ctx.baseUrl`）；`?v=NN` 是缓存破坏参数、必须保留（loader 对非 TS specifier 原样透传，Node ESM resolver 接受 `file://` URL 上的 query）。

### 3.2 客户端模块联动：私有成员绕过被官方入口替代

官方实现（`dsh-client-modules/lib/index.js`）：

- `:527-536` 构造函数里 `ctx.on("internal/plugin", (fiber) => { const entryName = fiber.entry?.options.name; if (entryName === void 0) return; this.dirty.add(entryName); if (this.flushQueued) return; this.flushQueued = true; queueMicrotask(() => { this.flushQueued = false; this.flush((err) => { ctx.logger.warn(err); …` —— **官方重扫通道就是重发这个事件**，由 microtask flush 收敛。
- `:791-793` `sourceKey(loaderName, baseUrl) { return \`${baseUrl}\0${loaderName}\`; }` —— 缓存键是 `baseUrl` + NUL + `loaderName`。这解释了旧实现为什么**语义上根本不可能生效**：调用方只拿得到裸包名，而按裸包名删缓存永远是 no-op。
- `:833` `processOne(entryName, onError)` —— `onError` 是**必填第二参**，只在内部 `catch` 里被调用（`:850-856`）。旧实现少传这个参数。
- `:871-892` `reconcilePackage(packageName)` —— 多来源时抛错（`:874-877`）；`const source = sources[0]; if (source === void 0) return this.table.delete(packageName);`（`:879`，**无来源时自行删行**）；`if (this.table.get(packageName)?.sourceKey === source.sourceKey) return false;`（`:880`，来源未变则返回"未变"）。

公开面（`dsh-client-modules/lib/types/index.d.ts`）只有 `artifactBaseline`(:126)、`rebuilt`(:134)、`onRebuilt`(:140)、`onGraphChanged`(:147)。而 `compose`(:148)、`resolveMeta`(:150)、`sourceKey`(:164)、`processOne`(:178)、`reconcilePackage`(:180)、`flush`(:181) 全部是 `private`。

**这里有个值得记录的判断**：`reconcilePackage` 的行为（按包名重协调）正是 injector 想要的，但它是私有的。守卫因此把"仓库触碰 `table` / `reconcilePackage`"判为违规（`guard/contracts.test.mjs:444`），而正确修法是**走官方事件重发**——这使一处原以为必须绕过私有成员的修复变成了常规迁移。

仓库侧落地：`injector/src/index.ts:2234-2244` 与 `:2347-2364` 用 `ctx.root.emit("internal/plugin", { entry: { options: { name } } })` 重发事件；`:2198` / `:2320` 直接在注释里引用 `dsh-client-modules/lib/index.js:791-793`，`:2207` 引用 `:527-537`，把"为什么不能按包名清缓存"写在代码里。

### 3.3 cordis 包名

裸名 `cordis` / `cosmokit` / `schemastery` 在 `0.2.0-rc.2` 下不可解析。仓库侧已全部 scoped：根 `package.json:70` 与 `injector/package.json:41` 均为 `"@deepseek-ai/cordis": "~4.0.4"`；脚手架模板 `injector/src/index.ts:107-112` 与 `:4400` 的 build.sh 模板里 `link_pkg @deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 均已改；模板中的 import 语句 `:173` / `:231` / `:338` / `:4395` 都是 `import type { Context } from '@deepseek-ai/cordis'`。

### 3.4 类型声明面：两条路，别走混

`guard/contracts.mjs:466-470` 的注释把这个区分写清楚了：

- **graded 的正确修法是删字段** —— 它的构建只复制文件、不产声明，所以 `types` 指向一个永不存在的路径。
- **injector 的正确修法是让构建真的产出** `lib/types/` —— `injector/tsconfig.json:9-10` 设了 `declaration: true` 与 `declarationDir: "lib/types"`，构建确实产出声明，所以 `types` 应该指向它。

两条路都对，前提是"声明文件是否真的存在"要和 `types` 字段一致。这是"悬空元数据路径"这一类问题的完整定义。

### 3.5 工具注销：`register()` 的返回值就是 disposer

`dsh-tools/lib/index.js:2878-2886`：

```js
register(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || …) throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  assertSupportedJsonSchema(output.schema);
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved …`);
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

其文档注释 `:2876` 写的是 `@returns the exact disposer that unregisters the tool.` —— **返回值就是官方 disposer，接口与实现里都不存在 `unregister` 方法**。

另一个同样重要的结论在 `defineTool`（`:848-850`）：

```js
const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
const validate = (args) => validateJsonSchemaValue(parameters, args, "");
```

即**参数校验闭包只由 `defineTool()` 生成**。而 `register()` 自身只对 `output.schema` 调 `assertSupportedJsonSchema`（`:2882`），**完全不校验 `parameters`**。所以绕过 `defineTool` 直接塞 raw `parameters` 的结果是**零参数校验**——这是一条静默失效，不是报错。

仓库侧落地：`injector/src/index.ts:3215-3242` 段注释写明上述结论；`:3231` `const toolDisposers = new Map<string, () => void>();`；`:3238-3242` `const dispose = ctx.effect(() => ctx.tools.register(tool), …); if (name) toolDisposers.set(name, () => dispose());`。自净函数 `purgeStaleTools()` 在 `:3284`，`:3291-3295` 按名取 disposer 并调用，`:3303` 输出 `"[super-injector] 已注销 %d 个本插件残留工具注册（走 disposer）"`，`:3308` 报出未登记的项，`:3318` 在启动时调用它。

### 3.6 `ctx.on('dispose')` → `ctx.effect`

`dispose` **不是** cordis 事件，`ctx.on('dispose', cb)` 永远不会触发——清理逻辑静默不执行。修法见 `graded/src/index.js:647-657`，其注释原文即「修复（工单 11）：这里原本写的是 `ctx.on('dispose', cb)` —— `dispose` **不是** cordis 事件」，现改为 `ctx.effect(() => …, "graded-mode: reset active session on dispose")`。同文件 `:371` / `:470` / `:512` / `:545` / `:606` 也统一为 `ctx.effect`。

守卫侧对应 `guard/contracts.mjs:83` 的 `cordis-event-names`，并有一条专门的断言（`guard/contracts.test.mjs:433`）：**断言 `dispose` 不在 harness 的事件清单里**。这条断言的意义是防止有人"顺手把 dispose 加回事件白名单"来让违规消失。

## 4. 工单总览表

12 个工单的定义在 `.scratch/protocol-sync/issues/`。「状态」列是**本次审计实测的落地情况**，不是工单文件里的 `Status` 字段——那 12 个文件的 `Status` 全部仍是 `ready-for-agent`，没有随实际完成更新。

| # | 标题 | 实测状态 | 主要改动文件 |
| --- | --- | --- | --- |
| 01 | 建立协议契约基线：把 harness 权威接口固化成可执行的守卫 | 已完成 | `guard/contracts.mjs`、`guard/lib/probe.mjs`、`guard/snapshot.mjs`、`guard/tickets.json`、`guard/README.md`、`guard/contracts.test.mjs`、根 `package.json`（scripts） |
| 02 | 修正注入器引导行声明与 cordis peer 依赖，消除不可解析的包名 | 已完成 | `package.json`、`injector/package.json`、`injector/src/index.ts`（脚手架模板的 `link_pkg` 行与 import 语句） |
| 03 | 修复注入器的客户端模块联动：补全回调节点、消除私有成员绕过 | 已完成 | `injector/src/index.ts`（`:2234-2244`、`:2347-2364` 重发官方事件；`:2164`、`:2193-2214`、`:2316-2326`、`:4720-4726` 注释） |
| 04 | 修复工具注销与客户端插件类型契约 | 已完成 | `injector/src/index.ts`（`:3230-3242` 保留 disposer）、`injector/src/client/index.ts:14`（改从 `@deepseek-ai/cordis` 导入 `Context`） |
| 05 | 让注入器的残留清理走副作用注销，不再依赖私有表 | 已完成 | `injector/src/index.ts`（`purgeStaleTools()` `:3284-3308`、启动调用 `:3318`；转正工具 `:1754-1755`、`:1828-1846`、`:1990-2009`、`:2038-2040`） |
| 06 | 引入 bundle 装载机制并把路由预设迁移为声明行（先 standard 打样） | 已完成 | `preset/router-standard/bundle/package.json`、`preset/router-standard/bundle/cordis.patch.yml`、`preset/router-standard/bundle/*.mjs` |
| 07 | 把 react 与 spec 两个预设迁移为 bundle 声明行 | 已完成 | `preset/router-react/bundle/`、`preset/router-spec/bundle/`（各含 `package.json`、`cordis.patch.yml`、`router-bootstrap-v17/v10.mjs`、`router-core-v17/v10.mjs`） |
| 08 | 重写预设快照同步脚本，适配 bundle 装载与 profile 约定 | **未完成** | 待改：`preset/scripts/sync-preset.cjs`（详见第 7 节） |
| 09 | 修正 graded 插件的装载声明与失效元数据 | 已完成 | 删除 `graded/dsh.plugin.json`、`graded/scripts/fix-ids.mjs`；`graded/package.json`（去掉 `engines` 与 `types`）；新增 `graded/scripts/env-paths.mjs` |
| 10 | 对齐 graded 工具定义与当前注册契约（参数校验 + 官方形态） | 已完成 | `graded/src/tools.js`（`:30` 引入 `defineTool`；6 处 `defineTool({…})` 在 `:198`、`:298`、`:380`、`:425`、`:548`、`:768`） |
| 11 | 修复 graded 生命周期清理与请求校验逻辑 | 已完成 | `graded/src/index.js`（`:647-657` 改用 `ctx.effect`；`:521-526` 修三元表达式）；新增 `graded/tests/w11-lifecycle-request.test.mjs` |
| 12 | 端到端装载验收并把审计文档定稿 | **部分完成**：文档即本文件；端到端装载未执行 | 本文件；待做：真实安装 + 重启验证 + 热装卸 + profile 备份与回滚记录 |

### 4.1 两个值得单独说明的工单

**06 —— "补上官方同类预设具备而本预设缺失的行"。** 用行级对比核实：官方 `dsh-web-app/presets/standard.patch.yml` 有 33 个 `- id:`，本仓 `preset/router-standard/bundle/cordis.patch.yml` 有 39 个。官方有而本仓没有的**只有 `preset-standard`**（本仓对应行是 `preset-router-standard`，即声明行本身，本就应该不同）；本仓多出 6 行：`router-bootstrap`、`gitbash-shell`、`gitbash-executor`、`tool-bash-posix`、`time-context`、`tool-str-replace-editor`——都是路由预设自己的行。即"官方有的行本预设都有了"这条验收成立。字段侧同样核实：本 patch 含 `modelSelectionSettings: true`(`:242`) 与 `backgroundMode: continuable`(`:243`、`:256`) / `one-shot`(`:273`、`:282`)。

**07 —— react / spec 与 standard 的差异是刻意的。** 两个 patch 的头部注释 `:11-13` 明确写 `order` **刻意缺席**：legacy `preset.yml` 本来就没声明，这两个是实验性预设、picker 位置不重要，「加一个数字等于发明一个该预设从未做过的排序决定」。`:19-20` 另写明插件列表是逐行照抄**本预设自己的** `agent.cordis.yml`、不是从 standard 抄的。显示名保留 `(experimental)` 后缀（`Router React (experimental)` / `Router Spec (experimental)`）。

### 4.2 `dsh-tool-schedule`：不加是正确决定

三个 preset bundle **刻意都不加** `dsh-tool-schedule` 这一行。依据（均已实测）：

- 在已安装 harness **整树**搜 `dsh-tool-schedule` → **0 命中**（含所有 `*.yml` / `*.yaml` 与全部文件）；安装树里同名目录数 = 0。
- `packages.md` 里 `schedule` 只有 3 处：`| @deepseek-ai/dsh-client-ui-schedule | no | … |`(`:90`)、分组标题 `## schedule`(`:338`)、`| @deepseek-ai/dsh-schedule | yes | … |`(`:342`)。**没有 `dsh-tool-schedule`。**
- checkout `0.2.1-alpha.1` 里 `packages/schedule/tool-schedule` **存在**。

结论：加进去会在激活时失败，等 harness 升级到带它的版本再加。这与 `preset/router-standard/bundle/cordis.patch.yml:124-129` 的 NOTE 一致。

**但该 NOTE 的一个子论断未能验证**：NOTE 说「官方 Web `standard` 预设带这一行」。实测官方 `dsh-web-app/presets/standard.patch.yml` 里**没有任何 schedule 行**（grep `schedule` 0 命中）。因此「官方 standard 预设也带这一行」在已安装的 `0.2.0-rc.2` 上**无法复现**。这不影响"不加"这个决定——决定成立靠的是上面三条独立证据——但 NOTE 的措辞与实测不符，建议后续修正为"该包在 0.2.0-rc.2 不存在"。

## 5. 守卫机制说明

### 5.1 六条契约各查什么

全部定义在 `guard/contracts.mjs`，全部 `severity: "blocking"`。

| 守卫 id | 定义行 | 查什么 |
| --- | --- | --- |
| `cordis-event-names` | `:83` | 仓库里 `ctx.on(...)` / `ctx.emit(...)` 用的事件名是否存在于 harness 的真实事件清单；并专门断言 `dispose` **不在**清单里 |
| `dsh-tools-register-parameters` | `:163` | 工具定义是否走 `defineTool()`（否则参数零校验）；`register()` 的调用形态是否与 `output { schema, render }` 契约一致 |
| `client-modules-public-surface` | `:201` | 仓库是否触碰 `dsh-client-modules` 的私有面（`table` / `reconcilePackage` / `processOne` 等）；公开面用法是否只用真实存在的方法 |
| `installable-package-names` | `:299` | 仓库里出现的每个 `@deepseek-ai/*` specifier 是否都在 `packages.md` 的可安装清单里 |
| `harness-version-alignment` | `:349` | 安装的 harness 版本与仓库声明的版本是否对齐（`BASELINE_HARNESS_VERSION = "0.2.0-rc.2"`，`:31`） |
| `package-metadata-paths` | `:377` | 各 `package.json` 的 `main` / `types` / `exports` / `dsh.bundle.patch` 等路径引用是否**真实存在**（"悬空元数据路径"） |

### 5.2 违规分档：由台账数据驱动，不改守卫代码

分档逻辑在 `guard/contracts.mjs:555-559`：

```js
const pending = owner !== null && !DONE_TICKETS.has(owner);
```

含义是：一条违规如果**能归属到某个工单**、而该工单**还没进 `done`**，它属于"**只报告**"（WARN，不阻断）；一旦该工单进 `done`，同一条违规立刻转为**阻断**（FAIL）。归属不到任何工单的违规**从一开始就是阻断**。

这样设计的好处是：工单落地时**不需要改守卫代码**，只要把工单号加进 `guard/tickets.json` 的 `done` 数组。反向也成立——把工单号从 `done` 里拿掉，违规自动退回"只报告"，所以"转阻断"是可逆的、纯数据驱动的（`guard/contracts.test.mjs:305` 有一条测试专门锁定这个可逆性）。

归属函数：`ownerForSpecifier`（`:446`）——`@deepseek-ai/dsh-client-runtime` → 工单 02；`@deepseek-ai/dsh-workflow-worker-thread` → 按文件路径给 06 或 07，否则 `null`。`ownerForMetadataPath`（`:475`）——`injector/` → 03，`preset/router-standard` → 06，`preset/router-react|router-spec` → 07。

当前 `guard/tickets.json` 的 `done = ["02","03","06","07","11"]`。注意 `done` 里**没有 01**——01 是守卫自身，不需要给自己归属。`_ownerMap` 只登记了 5 条（11 / 02 / 03 / 06 / 07），其余工单没有可归属的守卫检查项（例如工单 08 的对象 `preset/scripts/sync-preset.cjs` 不在守卫扫描范围内，这是第 7 节的一个缺口）。

### 5.3 退出码 0 / 1 / 2

判定在 `guard/contracts.mjs:702-704`：

| 退出码 | 含义 | 触发条件 |
| --- | --- | --- |
| `0` | 全部契约满足 | 无阻断失败 |
| `1` | 有阻断失败 | `failed > 0` |
| `2` | **无法判定**（不是通过） | harness 不在本机（`runGuards()` 在 `:526` 直接返回 `unavailable: true` 且 `results: []`） |

**退出码 2 是刻意与 0 区分的**，这一点值得写进这里：如果"没探测到 harness"返回 0，守卫就会在没有 harness 的环境里**静默变成永真**——CI 上永远绿，而实际上什么都没查。把"无法判定"单独编码成 2，才能让流水线把"没查"和"查过且通过"分开处理。`guard/contracts.test.mjs:146` 与 `:193` 各有一条测试锁定这个语义。

守卫的 harness 位置解析顺序是 `--harness-root` → `DSH_HARNESS_ROOT` → 平台默认，且**显式指定具有权威性**：写错的路径不会被静默回落成"真安装"（`guard/contracts.test.mjs:154`、`:175`、`:185`）。

### 5.4 其他设计约束

- `guard/lib/probe.mjs` 是**唯一**解析实现，`guard/snapshot.mjs` 与守卫共用它（`guard/contracts.test.mjs:778` 有测试锁定"仓库里不存在第二套解析实现"）。
- `guard/snapshot.json` 刻意**不含时间戳与绝对路径**（`guard/contracts.test.mjs:804`），保证可复现、不泄露本机路径。
- 守卫**不需要网络、不启动 DSH**，纯静态解析（`guard/contracts.test.mjs:113`）。
- 公开面读 `.d.ts`、不读 `lib/index.js`——因为 esbuild 降级会抹除 `private` 标记，`lib/index.js` 里看不出哪些成员是公开契约。
- 包清单条数**不硬编码**（实时解析 `packages.md`，当前 242），`guard/contracts.test.mjs:858` 有一条测试断言守卫源码里不残留硬编码条数。
- `guard/README.md` **已过期**：正文写"五条守卫"并只列 5 条，漏了实际存在的第 6 条 `package-metadata-paths`。其余内容准确。这是文档漂移，不是守卫缺陷（见第 7 节）。

## 6. 验证方法

### 6.1 三层验收

按工单 12 的划分：前两层是各工单在自己的层面上的验收，第三层是把仓库作为整体真实装进运行环境。本文件按这三层记录实际达成情况。

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 第一层 | 组件内自测：单元测试、脚本跑通、selftest | **已执行**（本文件复核过的部分见 6.2） |
| 第二层 | 跨组件静态契约验收：守卫 + 快照自校验 + 类型检查 | **已执行，全绿** |
| 第三层 | 端到端真实装载：仓库作为 bundle 装入运行环境并重启，三预设可选且生效、注入器完成一次真实热装卸、graded 可触发、装载无契约相关警告 | **尚未执行** |

### 6.2 已执行的命令与实际输出

以下全部为本文件撰写时的真实执行结果，不是引用历史记录。

#### 守卫（第二层）

```text
$ node guard/contracts.mjs
契约守卫 — DSH 接口契约基线条
========================================================================
harness 安装：C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh
harness 版本：0.2.0-rc.2
可安装包清单：node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md
  条目数：242  sha256：20d4c693baaca4b9952e78815b1763eaa325ecf147cfffc2d1546291f19eb2c1
仓库 specifier 命中：430 处

[PASS] cordis-event-names  (blocking)
[PASS] dsh-tools-register-parameters  (blocking)
[PASS] client-modules-public-surface  (blocking)
[PASS] installable-package-names  (blocking)
[PASS] harness-version-alignment  (blocking)
[PASS] package-metadata-paths  (blocking)
------------------------------------------------------------------------
阻断失败 0 条，只报告不阻断 0 条，跳过 0 条，共 6 条守卫。
EXIT=0
```

注意 `跳过 0 条` 与 `阻断失败 0 条` 是两件事：前者说明 harness 探测成功（不是退出码 2 那条路），后者说明没有违规。

#### 回归测试（第一层 + 第二层）

```text
$ npm test
ℹ tests 37
ℹ suites 0
ℹ pass 37
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
EXIT=0
```

37 的构成经核实：`guard/contracts.test.mjs` 35 个 `test(` + `test/root-package-prepare.test.mjs` 2 个 = 37。

#### 快照自校验（第二层）

```text
$ node guard/snapshot.mjs --check
✓ 快照与当前 harness 一致：guard/snapshot.json
EXIT=0
```

#### injector 类型检查（第二层）

根目录**没有** `node_modules`，所以在仓库根跑 `npx tsc` 会得到：

```text
This is not the tsc command you are looking for
```

正确命令是进 `injector/` 用它自己的 typescript：

```text
$ cd injector && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
EXIT=0   （零错误）
```

### 6.3 端到端那层为什么还没做，以及它意味着什么

**第三层验收尚未执行。** 具体地说，以下事项**一件都还没做**：

- 没有把仓库作为 bundle 真实装入运行环境，也没有重启验证三个组件处于激活态
- 没有在新会话里确认三个路由预设可被选中并实际生效
- 没有做注入器的真实热装卸（不重启 DSH）
- 没有在会话里触发 graded 插件
- **没有备份 profile 配置与锁文件**，因此也还没有回滚记录

因此本文件对**所有**工单的结论都只能到"静态契约层与组件内测试层通过"为止。**第 4 节标"已完成"的工单，含义是"已修复且通过守卫与单元测试"，不等于"已在真实 DSH 里验证生效"。** 这个区分是工单 12 的硬性要求（`issues/12-…md:28`），也是本文件最需要读者注意的一点。

第三层之所以关键：前两层各自独立成立，但**没有任何一层验证过"三个组件在同一个进程里互不冲突"**。注入器会重发 `internal/plugin` 事件、preset 会往 Loader 里 insert 行、graded 会在客户端注册 UI——这些动作在同一进程里的相互作用，静态检查看不到。

## 7. 已知未完成项与风险

### 7.1 工单 08 完全未落地（最高优先级）

`preset/scripts/sync-preset.cjs`（129 行）**仍是旧协议版本**，工单 08 描述的四根支柱全部是断的，且逐条可实测：

| 支柱 | 实测 | 依据 |
| --- | --- | --- |
| 源码根路径拼错一层 | `REQ = path.resolve(__dirname, '..')` 得到 `preset/`，再 `path.join(REQ, 'preset')` 拼成 `preset/preset` —— **该目录不存在** | `preset/scripts/sync-preset.cjs:21` |
| DSH 主目录回退到本机不存在的路径 | `const DSH_HOME = process.env.DSH_HOME \|\| 'C:\\Users\\Eldwen'` —— 本机 `DSH_HOME` 实为 `C:\Users\Administrator\.dsh`，而 `C:\Users\Eldwen\.dsh` **不存在** | `:28` |
| 投放目标是已废弃的目录协议 | `const AGENT = path.join(DSH_HOME, '.dsh', '.agent-presets')` —— 双重错误：`DSH_HOME` 本身已经是 `.dsh`，再拼一层 `.dsh` 得到 `C:\Users\Administrator\.dsh\.dsh`（**不存在**）；且 `.agent-presets` 这个目录协议在 `0.2.0-rc.2` 里**零命中**（见 3.1） | `:29` |
| 硬编码运行目录版本号与实际文件名对不上 | `run: 'router-standard-v22'`（旧运行目录名）与 `:86` 硬编码的 `router-bootstrap-v34.selftest.mjs` | `:33`、`:86` |

另外 `:109` 的 `--bump` 仍在改 `agent.cordis.yml` 的 `?v=N`，`:112-123` 跑 selftest，文件头注释也仍在描述 `.agent-presets` 投放语义——整份脚本的语义都还停留在目录协议时代。

**后果**：工单 08 要求的"编辑源文件 → 同步生成快照 → 装载生效"这条链路**目前不可用**。而且这不是一个"跑起来会报错"的故障：脚本会静默地把文件写到错误的位置（`preset/preset` 不存在时行为取决于 `fs` 调用，`C:\Users\Administrator\.dsh\.dsh\.agent-presets` 则是写进一个没人读的目录），符合本次审计的典型失效模式——**静默不生效**。

**守卫没覆盖它**：`preset/scripts/` 不在 `guard/contracts.mjs` 任何一条守卫的扫描范围内，`guard/tickets.json` 的 `_ownerMap` 也没有工单 08 的条目。所以这条缺陷**不会**被 `node guard/contracts.mjs` 发现。这是守卫覆盖面的一个真实缺口。

工单 08 还带一个用户已决定的额外要求：**以无版本号为基准重新生成三个预设的快照**。原因是快照已经双向漂移、且三个预设的漂移方向各不相同，所以不能靠"以快照为准回灌源文件"来修（那会固化一个来路不明的旧版本）。这项也**未执行**。

### 7.2 注入器的脚手架模板仍在教旧写法

`injector/src/index.ts:381-407` 的 `SCAFFOLD_UI_CLIENT` 模板字符串里：

- `:388` `import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'` —— 实测 `SlotsService` 在**整个 harness 里 0 命中**。`dsh-client-ui-slots/lib/types/index.d.ts` 里真实的服务类是 `SlotCore`(`:712`)，另有 `StaleAuthorizationError`(`renderer.d.ts:254`) 与 `SlotOwnershipError`(`renderer.d.ts:261`)。
- `:390-392` 用本地 `type ClientContext = { slots: SlotsService }` **改写服务形状** —— 正是本次审计的共同根因（1.2 节）那一类反模式。

**为什么它躲过了检查**：这段代码位于模板字符串内，`tsc` 编译不到它，所以 `--noEmit` 全绿也发现不了。**后果**是每一个用注入器新建插件的人都会把不存在的类型名与本地断言复制进新项目，等于把本次审计修掉的病根继续向外传播。

对比：注入器**自身**的客户端插件已经修好——`injector/src/client/index.ts:14` 是 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`，`:168-176` 直接用 `ctx.slots.inject` / `ctx.slots.register` 并挂 `ctx.effect`，没有任何本地断言。**修了实例，没修模板。**

### 7.3 工单 11 的新测试没有接进测试脚本

`graded/tests/w11-lifecycle-request.test.mjs` 是工单 11 新增的，含 6 个测试：插件入口可加载（`:134`）、`ctx.effect` disposer 清理 `activeSid`（`:285`）、卸载前 `activeSid` 不跨会话泄漏（`:343`）、显式 `sid` 且盘档存在 → `ok:true`（`:358`）、显式 `sid` 但磁盘无档案 → `ok:false` / `reason:no-state`（`:375`）、未带 `sid` 时不触发"无盘档"判定（`:400`）。

但 `graded/package.json` 的 test 脚本只列了三个文件：`node --test tests/mode-state.test.mjs tests/tools.test.mjs tests/inject-text.test.mjs`。**`w11-lifecycle-request.test.mjs` 不在里面**，所以这 6 个测试在当前 `npm test` 路径下**不会被执行**。工单 11 的修复本身是对的（代码已改），但它的回归保护目前是"存在但没接线"。

### 7.4 文档漂移

- `guard/README.md` 正文写"五条守卫"并只列 5 条，漏了第 6 条 `package-metadata-paths`。守卫代码与测试都是 6 条（`guard/contracts.test.mjs:420` 有一条测试断言"六条契约各由一条守卫覆盖，且 id 稳定"），所以是 README 单方面过期。
- `.scratch/protocol-sync/issues/01-…12-….md` 的 `Status` 字段全部仍是 `ready-for-agent`，未随实际完成更新。本文件第 4 节的"实测状态"列是本次审计重新核定的结果。
- `preset/AGENTS.md` 描述的运行链路（`~/.dsh/.agent-presets/` 投放、`router-standard-v22` 运行目录、`DSH_HOME || 'C:\Users\Eldwen'`）**与 7.1 是同一批过时事实**，改 `preset/` 之前必须先纠正它，否则会照着错的指南操作。其中仍然有效的部分：编辑基准是**无版本别名**文件（`router-bootstrap.mjs` / `router-core.mjs` / `agent.cordis.yml`），`-vNN` 是同步生成的快照、不要手改；无版本别名不等于历史文件，勿删勿移；验证命令 `node preset/router-standard/router-bootstrap-v34.selftest.mjs` 应输出 `SELFTEST PASS`。

### 7.5 未能验证的断言（如实列出）

1. **`dsh-tool-schedule` NOTE 的子论断**：「官方 Web `standard` 预设也带这一行」——官方 `dsh-web-app/presets/standard.patch.yml` 里没有任何 schedule 行，在已安装的 `0.2.0-rc.2` 上无法复现。不影响"不加"的结论（见 4.2），但 NOTE 措辞与实测不符。
2. **profile 悬空引用**：工单 08 要求清理"profile 补丁文件里指向路由预设、却匹配不到声明行的配置项"。实测 `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` 里搜 `router|preset|agent-preset` 只命中 `@deepseek-ai/dsh-permission-presets`(`:133`)、`presets:`(`:135`)、`defaultPreset: danger-full-access`(`:145`)；在整个 `profiles/` 目录搜 `router-standard|router-react|router-spec` → **0 命中**。也就是说**当前这个 profile 里没有悬空引用可清理**——但这只能说明"这一台机器的这一个 profile 现在是干净的"，不能说明其他 profile 或其他机器也干净。
3. **端到端装载的实际表现**：完全未观测（6.3 节）。
4. **`graded/tests/` 其余测试与 `preset/router.test.mjs`、`preset/router.integration.test.mjs` 的实际通过情况**：本文件只执行了仓库根的 `npm test`（37 个测试）。`graded/` 与 `preset/` 各自的测试套件未在本轮执行，它们的状态需要各自单独核实。

### 7.6 风险小结

| 风险 | 影响 | 现状 |
| --- | --- | --- |
| 同步链路不可用（7.1） | 改了源码无法可靠地同步到运行环境；快照继续漂移 | 未修，且守卫不覆盖 |
| 脚手架模板传播旧写法（7.2） | 新建的插件持续复制本次审计修掉的病根；`tsc` 抓不到 | 未修 |
| 端到端从未验证（6.3） | "三个组件在同一进程互不冲突"这一条**无任何证据** | 未做 |
| 回归保护未接线（7.3） | 工单 11 的修复可能被后续改动悄悄破坏 | 未接线 |
| 文档漂移（7.4） | 照 `preset/AGENTS.md` 操作会走到不存在的路径 | 未修 |
| 快照双向漂移（7.1） | 三个预设的 `-vNN` 快照与无版本基准不一致，方向各不相同 | 未修，用户已决定"以无版本号为基准重新生成" |

---

**审计基准**：已安装 DSH `0.2.0-rc.2`（`C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`）
**权威包清单**：242 条，sha256 `20d4c693baaca4b9952e78815b1763eaa325ecf147cfffc2d1546291f19eb2c1`
**本文件范围**：仅记录本次协议同步审计；不含未复核的第三方转述。
