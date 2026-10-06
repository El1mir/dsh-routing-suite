# 契约守卫（protocol guard）

一条命令，检查本仓库对 DSH harness 的接口用法是否还对得上**本机真实安装的 harness**。

```bash
npm run guard            # 人类可读报告
npm run guard:json       # 机器可读（含逐条违规的结构化位置）
npm run snapshot         # 重新生成权威接口快照
npm run snapshot:check   # 校验快照是否与当前 harness 一致
npm test                 # 守卫自身 + 仓库既有测试
```

## 它解决什么问题

本仓库三个组件（`injector/`、`preset/`、`graded/`）都通过字符串包名、`.d.ts` 里的接口形状、
以及运行时对象的成员名与 harness 耦合。这类耦合**静态类型检查发现不了**：`ctx.get()` 返回
`unknown`，本地类型断言是唯一的类型约束，契约对不上时 TypeScript 不报错，只在运行时暴露；
而外层普遍包着 `catch`，于是真实的故障表现是**功能静默不生效**，不是崩溃。

守卫把这个"下次再漂移时靠人工全盘审计才发现"的问题，变成一次可自动运行的断言。

## 六条守卫

| id | 断言的契约 |
| --- | --- |
| `cordis-event-names` | 仓库里 `ctx.on(...)` 用到的每个事件名，都必须在 harness 全树 `Events` 接口的并集里（`dispose` 不在其中） |
| `dsh-tools-register-parameters` | `register()` 只校验 `output.schema`、**不**校验 `parameters`；`parameters` 的 DSL 编译发生在 `defineTool()` 内 |
| `client-modules-public-surface` | `ClientModuleRegistry` 的公开/私有成员划分（`rebuilt` 公开；`table`、`processOne`、`reconcilePackage` 私有） |
| `installable-package-names` | 可解析的源码、元数据、Cordis 补丁和安装脚本中的包名须在可安装清单或安装树中存在（`.md` 散文不扫描） |
| `harness-version-alignment` | 仓库声明的 DSH 版本与本机安装版本一致 |
| `package-metadata-paths` | `main`/`module`/`types`/`typings`/`bin`/`exports`/`files` 引用必须解析到包内真实文件或目录 |

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 无阻断失败（仍可能打印 report-only 违规） |
| `1` | 有阻断失败 |
| `2` | **探测不可用**（harness 不在本机 / 权威文件读不到）。此时**未做任何断言**——既不算通过，也不算违规 |

退出码 2 是刻意与 0 区分的。把"没探测到"当成"契约满足"会让守卫在任何没有 harness 的环境
（CI、新机器）里静默变成永真断言，这正是要避免的失效模式。

## 两档严重性：为什么有些违规不阻断

工单 02–11 正在修一批已知的旧写法。在它们落地之前，守卫对**归属到未落地工单**的违规
只报告不阻断，避免在修复完成前让整条流水线红掉。转阻断是**数据驱动**的，不需改守卫代码：

把工单号写进 `guard/tickets.json` 的 `done`，归属该工单的违规即刻转为阻断（工单已声称修完，
违规还在 → 说明修复不完整或发生了回退，必须挡住）。`guard/tickets.json` 的 `_ownerMap`
记录了每个工单号负责什么。

反过来，旧写法被删掉后守卫自然变绿，同样不需改代码。

## 探测逻辑只有一份

`guard/lib/probe.mjs` 是**唯一**的解析实现，守卫与快照都从它取数。不允许多写一套解析——
两套解析会在 harness 升级时产生分歧，而分歧本身比漂移更难查。

`guard/snapshot.json` 是这套探测的产物，用于人工审阅"本机 harness 现在长什么样"。
它刻意不含时间戳与绝对路径，因此可跨机器复现。

## 环境

- **不需要网络**：只读本机文件。
- **不启动 DSH**：纯静态解析，不 `require` harness 代码，也不装载任何插件。
- harness 位置按以下顺序确定：`--harness-root <path>` → `DSH_HARNESS_ROOT` → 平台默认 npm 全局路径。

**显式指定具有权威性**：给了 `--harness-root` 或 `DSH_HARNESS_ROOT` 就只认它，不会因为该路径
不合法而悄悄回落到本机真实安装。这一点是刻意的——把显式路径当成"先试这个、不行再猜"的提示，
会让写错的路径被静默忽略，于是"harness 不可用"这条分支永远走不到，拿到的是一个看起来成功的假结果。

## 已知的判定依据与偏差

- **公开面读 `.d.ts`，不读 `lib/index.js`**：发布的 `lib/index.js` 经过 esbuild 降级，
  `private` 修饰符被完全抹除，运行时 JS 里无法区分公开面与内部实现。
- **包清单条数不硬编码**：从 `packages.md` 实时解析（当前 242 条）。写死数字会在 harness 升级后静默失效。
- 本仓库审计把 `reconcilePackage` 记为 `ClientModuleRegistry` 的**私有**成员——尽管它的行为
  （无来源时删行、来源变化时重建）正是 `injector` 想要的"按包名重协调"。因此守卫断言它是私有，
  而不是把它当成公开入口。
