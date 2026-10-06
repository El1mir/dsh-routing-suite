# AGENTS.md — dsh-router-standard 预设开发指南

> **中心思想（理念与精神）** —— 这是本预设研发的最高纲领，一切决策以它为准。
>
> 1. **研发核心是「底层注意力机制」和「交付质量收敛」，不是自研工具。** 工具（page_check 等）
>    大道至简——删掉反复出 bug 的自研工具，让模型自己装 CLI 自测（bash 跑 playwright/headless Chrome），
>    预设专注注意力机制 + delivery_check 门禁。
> 2. **从「模型底层特性」入手，用数据说话，拒绝形而上学。** 每一条引导/机制都要在真实会话或 api1
>    实测（读 `reasoning_content`）验证过，不凭空造机制、不为填充而改。
> 3. **深度思考无所谓，重要的是「提高思考质量、打破局限思维」。** 不压制思考、不催速；
>    但警惕"局部最优思维"（卡在单点细节反复循环）——引导模型保持整体可用、别被顽固细节卡住交付。
> 4. **道德为主、法治为辅。** 引导内在动机（"做扎实、给安全感、不焦虑下阶段"）优于外部强制规则；
>    gate（delivery_check）兜底施压但不制造焦虑。
> 5. **不惯性、不时务**：报废的技术不优化、直接删；不因"以前这么做"而延续；每个判断基于当下的实测。
> 6. **重成果，思时间**：看思考质量/是否专注/是否偏离，而非跑多久；每会话 2h 预算上限。
> 7. **对外：公开产线要稳定**；对数据：标签+实验记录，测完归档到 `dsh-实测归档/`，测试环境保持干净。
>
> 相关演进见 `CHANGELOG.md`；核心机制判断见 `docs/` 与归档 `核心机制反馈-v123-优化方向.md`。

> `dsh-routing-suite/preset` = 路由预设源码仓库（子模块），含三大预设：
> **router-standard（v34，主力）** / **router-react（v17）** / **router-spec（v10)**。
> 本文档给 agent/开发者：怎么改、怎么验、怎么同步到 DSH、怎么生效。
> 权威规范（哲学/设计）见 `README.md` 与 `docs/`；演进史见 `CHANGELOG.md`。

## 开发链路全貌

```
改源码(无版本别名) → selftest 就地验证 → sync-preset 重生版本快照 → 重启 DSH 生效
```

每个预设都是「**源码 = 编辑基准，版本快照 = 同目录的 `-vNN` 文件**」。bundle 时代
运行位置不再是 `~/.dsh/.agent-presets/`：每个预设是一个独立 npm 包，其
`bundle/` 子目录由 `dsh plugin --profile web add` 装配（junction 链到源码目录），
`bundle/cordis.patch.yml` 才是 loader 真正读的装配文件。

| 预设 | 源码目录 | 编辑基准（无版本别名） | 版本快照 | 当前版本 |
|---|---|---|---|---|
| router-standard | `preset/router-standard/` | `router-bootstrap.mjs` / `router-core.mjs` | `router-bootstrap-v34.mjs` / `router-core-v34.mjs` | v34 |
| router-react | `preset/router-react/` | 同上 | `-v17.mjs` | v17 |
| router-spec | `preset/router-spec/` | 同上 | `-v10.mjs` | v10 |

> ⚠️ `router-<id>/` 与 `router-<id>/bundle/` 各存一份快照，由 sync-preset 同时写入；
> 前者供 selftest 与 `preset/router.test.mjs`，后者是 loader 实际读的那份。

## 编辑基准（改哪里）

**改源码目录的无版本别名**，不是带版本号文件：

- `preset/router-standard/router-bootstrap.mjs` ← 主编辑对象
- `preset/router-standard/router-core.mjs` ← 路由逻辑
- `preset/router-standard/bundle/cordis.patch.yml` ← 装配配置（声明行 + persona/sections/工具行）
- 源码里**无版本别名** == 带版本 `-v34.mjs`（一致），无版本别名是纯源，`-v34` 是同步生成的快照。

> 常联动改：bootstrap（机制）+ core（逻辑）+ `bundle/cordis.patch.yml`（工具面/版本戳）。

## 验证（改完就地测）

```bash
# 源码目录即可验证（selftest 已同步进源码）：
node preset/router-standard/router-bootstrap-v34.selftest.mjs   # → SELFTEST PASS
# 或完整测试（依赖 node，来自 Eldwen 用户 nvm）：
# node --test router.test.mjs   # 单元测试
```

## 重生版本快照（sync-preset）

```bash
node preset/scripts/sync-preset.cjs router-standard          # 别名 → -vNN 快照（写 router-<id>/ 与 bundle/ 两份）
node preset/scripts/sync-preset.cjs --all                    # 三个预设一次做完
node preset/scripts/sync-preset.cjs --all --check            # 只校验一致性，不写盘
```

- 版本号唯一来源 = `bundle/cordis.patch.yml` 里的 `router-bootstrap-v(\d+)\.mjs`，不从文件名反推。
- 脚本替代已废弃的 `routing-probe/sync-*-v*.cjs` 与旧的「复制到 `.agent-presets`」流程。
- `--bump` **已退化**为「确认没有残留的 `?v=`」。bundle 协议下不需要缓存破坏：
  bundle patch 只在 DSH **启动时**读取，重启既重读补丁、也丢弃 ESM 缓存。
  反过来说，运行时行**带上** `?v=N` 会直接把预设写坏（见下「关键坑」4）。
- `node preset/scripts/check-bundles.cjs` 是模块行解析判定的**唯一实现**（install.ps1 / install.sh 都调它）。

## 生效（DSH 加载新代码）

**只有一个机制、也只有一步：重启 DSH。** bundle patch 只在启动时读取
（`AgentPresetRegistry.recompose` 用的是 registry 已保存的 definition，不会重读 patch），
而重启同时也会丢弃 ESM 缓存，所以不存在「还需要 bump 一个缓存戳」这回事。

```bash
dev_reload_preset router-standard   # 只是**自检**：报告运行时行能否被解析（已不做热重载）
# 然后重启 DSH —— patch 重新读取，新会话即用新代码
```

> `dev_reload_preset` 与 `dev_reload_preset_live` 都**不做热重载** —— 它们会显式告诉你
> 「改写 bundle patch 当场无效，请重启」。别再找缓存戳的开关，它不存在。

## 关键坑（实测血泪）

1. **`.agent-presets` 目录协议已死**：当前 harness（0.2.0-rc.2）安装树里没有任何代码读
   `~/.dsh/.agent-presets/`；预设只能通过 Cordis composition 声明行注册（`@deepseek-ai/dsh-agent-preset`）。
   仓库内脚本一律按 bundle 协议工作，不再解析 `DSH_HOME`。
2. **运行时行必须是裸包名子路径**：写 `@dsh-external/dsh-preset-router-<id>/router-bootstrap-vNN.mjs`
   （经 `bundle/package.json` 的 `exports` 映射解析），这也是官方每个预设补丁的做法。
   仓库脚本 `preset/scripts/check-bundles.cjs` 与 `sync-preset.cjs --check` 会校验这一点。
3. **无版本别名 ≠ 历史**：源码的 `router-bootstrap.mjs`/`router-core.mjs` 是**当前版兼容别名**（probe/测试引用），
   不是历史文件。**勿删、勿移**。真正历史版本在 `docs/archive/`（react v1-8/spec v1）。
4. **相对行永不被锚定，`?v=` 会直接写坏预设**（三个预设曾全部因此加载失败）：
   `anchorInsertedPluginNames`（`dsh-app-boot`）只重写它经
   `entry.group && Array.isArray(entry.config)` 能走到的 `name` 字段，而预设的运行时行嵌在
   `insert[].config.plugins[].name`（`config` 是对象）里 —— 于是相对行 `./x.mjs` **永远不被锚定**，
   Loader 按 `ctx.baseUrl`（= profile 目录）解析，报 `ERR_MODULE_NOT_FOUND`，整个预设静默不加载。
   而裸包名子路径**不能**带查询串：`exports` 精确匹配，`?v=88` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
   守卫快照存了判据：`guard/snapshot.json` 的 `loaderResolution.anchorsOnlyGroupArrayConfig = true`
   与 `anchorsConfigPlugins = false`；上游一放宽，`node guard/snapshot.mjs --check` 立刻漂移。
5. **历史版本堆积**：旧版快照文件曾在运行目录 `_archive_versions/`（v22-v33），源码只存当前版。
   若再堆积，用 `_archive_versions/` 方式归档而非删除。

## 版控边界（.gitignore）

- `probe/` 是**历史实验快照**（脚本已断链，不修依赖），数据/大件入 `.gitignore`。
- **保留**：`probe/*.mjs`、`probe/*.py`、`probe/README.md`（历史档案）。
- **忽略**：`probe/deepseek-v4-pro-weights`/`dsh-2020-dataset`/`deepseek-tokenizer`/`results`/`sessions`/候选池 json。
- probe 详细说明见 `probe/README.md`。

## 工作流速查

```bash
# 1. 改编辑基准（无版本别名 + bundle/cordis.patch.yml）
# 2. 就地验证
node preset/router-standard/router-bootstrap-v34.selftest.mjs   # → SELFTEST PASS
# 3. 重生版本快照
node preset/scripts/sync-preset.cjs router-standard
# 4. 重启 DSH —— bundle patch 只在启动时读取
```