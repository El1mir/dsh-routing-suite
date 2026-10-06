# Changelog

## 未发布（元数据与脚本检修）

- **删除 `dsh.plugin.json`**：声明 `contributes.commands: ["分级"]`，但当前 harness **整个安装树无任何代码读取该文件名**（对 `<dsh 安装根>` 下全部 `*.js/*.mjs/*.cjs/*.ts` 做全文搜索，零命中）。命令实际由 `src/index.js` 的 `ctx.commands.register({...})` 在运行时注册，功能不受影响——留着只会让人以为这份声明在起作用。
- **`package.json` 移除 `engines.dsh`**：harness 从不读取该字段（官方 `dsh-app-boot` README 明确「version checks use peer declarations, **not `engines.dsh`**」；`dsh-package-manifest` README 亦称该字段**不被执行**）。版本兼容改用官方机制：新增 `peerDependencies`（`@deepseek-ai/cordis ~4.0.4`、`@deepseek-ai/dsh-tools 0.2.0-rc.2`，与本机 harness 实测版本一致）。
- **`package.json` 移除悬空 `types`**：原指向 `./lib/types/index.d.ts`，但 `scripts/build.mjs` 只做文件复制、**不生成任何声明文件**，仓库内无 tsconfig、无 `.d.ts`、打包产物中亦无 `lib/types` 条目。决定不产出类型，故移除该字段（含 `exports["."].types`），不留悬空引用。
- **新增 `scripts/env-paths.mjs`**：端到端脚本共用的环境路径推导（npm 全局目录 / DSH 安装根 / DSH 主目录 / dsh 自带 `ws`），推导失败时打印可执行的修复指引并退出 2，取代原先写死的字面占位符。
- **`scripts/e2e-develop.mjs`、`scripts/e2e-v4.mjs`**：`PATH_TO_NPM_GLOBAL`（ws import）与 `PATH_TO_PLUGIN`（会话工作目录）改为 env-paths 推导值；顺带清除失效的重复 import 与未使用变量。
- **删除 `scripts/fix-ids.mjs`**：一次性会话日志修复工具，**破坏性、无 dry-run、无备份**，原地重写整个 profile 下的每个 `session.jsonl.zstd`；且依赖未声明的外部 `python` + `zstandard`，读取路径写死为 `PATH_TO_DSH_HOME/sessions`。它针对的 `SessionPersistenceCorruptionError`（消息缺 `id`）是一次已过去的历史事故，仓库内除自身外无任何引用。把占位符换成真实路径只会让"误跑一次即不可逆"的风险变得更容易触发，故整体删除而非迁移。

## 0.0.1-rc1（2026-09-02）Release Candidate

- 注入淤积根治：focus 幂等键去 status（状态抖动不再重注同名引导）；执行端续轮 followup→steer + 同 turn 60ms 引导合并（消除 next-turn 堆积）
- 面板稳定：会话感知三级回退（URL/历史解析 ?sid=/盘 mtime）+防错显示；**设置面板闪退修复**（effect 一次挂载+回调 ref 化）
- 概念上限动态化：loadConceptLimit 读路径对齐设置 API（此前写读不一致致设置失效）——phaseL2/焦点注入/schema 描述全随设置（实测 8 全链断言）
- 面板视觉：已完成组默认折叠+组进度徽标+完成态侧条
- 测试 62/62；`0.0.1-exp` 为前一实验版（历史保留）

## 0.0.1-exp（2026-09-02）体验实验版

- 脑暴出题制：ask_user_question 选择题对齐（多轮歧义结清）+必选模式题（用户点选，经 commit_star(mode) 落盘）
- 时序修复：大小类引导走 next-step（同轮即时，无过期）；锁定回执=完整规格单；审核唯一确认请求；『修改』回滚开口（reject-ack）
- 小类粒度模式 item.mode（缺省继承会话；scanMode 只认用户=防漂移）
- 北极星锚定替代"开工前自问"；委派允许情景改写（验收锚=盘档规格）+委派通道自主决策（后台/阻塞）
- commit_star 修订保留阶段（修复回退 bug）；focus 模式标注修复；开源脱敏（发布面路径占位/os.homedir 回退/硬编码净化+红队两轮复核）

## 3.1.0（2026-09-01）规格化重设计

- 脑暴链→commit_star 定稿；规格化两级计划（spec/accept/do/verify 必填门控）
- 注入规格前置三段式+委派/编排/红队/双轨 skill 卡；组收官逐条核对+verify 注入
- 状态磁盘单轨（热重载零中断）；审计端点；超级面板（三层树/量化/北极星/红队灯）

## 3.0.0（2026-09-01）正式版

- 两级任务协议：大类→锁定→小类→锁定→树状审核→打卡制开发→组收官→终验
- 三模式包（correct/experience/research）；先注后键单注；当下态回执
