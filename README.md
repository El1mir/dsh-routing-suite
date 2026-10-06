# DSH Routing Suite 用户教程

DSH Routing Suite 是一套面向 DeepSeek Harness（DSH）的 agent 基础设施套装。它把 **插件生命周期管理、模型工作方式路由、复杂任务规格化交付** 组合在一起。

```text
injector  →  管插件如何安装、注入、热重载和卸载
preset    →  管模型采用什么思维/执行方式
graded    →  管复杂任务如何澄清、计划、执行、审核和验收
```

目标环境：DSH `0.2.0-rc.2`，Node.js `>=22`。

## 1. 三个组件分别做什么

### `injector`：插件运行时管理器

传统插件改完配置后通常需要重启 DSH。`injector` 提供运行时开发通道：把标准插件包直接注入当前运行中的 web，host 工具和 client UI 一起生效。

它适合解决：快速试用新插件、改代码后热重载、失败回滚、干净卸载，以及测试工具不污染正式 tools schema 等问题。

主要工具：

| 工具 | 用途 |
| --- | --- |
| `dev_inject_plugin` | 注入本地完整插件包 |
| `dev_reload_package` | 清缓存、重新加载并重建 fiber；失败回滚旧版本 |
| `dev_uninject_plugin` | 清理工具、监听器、路由、client 状态并卸载 |
| `dev_install_package` | 正式写入 profile bundles，重启后恢复 |
| `dev_plugin_status` / `dev_injected_list` | 查看插件和注入状态 |
| `dev_clear_routes` | 清除热重载留下的 webserver 孤儿路由 |
| `dev_stage_add` / `dev_stage_call` | 在后侧测试工具，不进入正式 schema |
| `dev_stage_promote` / `dev_stage_demote` | 转正或撤回测试工具 |

它还提供插件生产线：

```text
dev_scaffold_plugin → dev_build_plugin → dev_inject_plugin
                                      ↘ dev_release_plugin
```

可生成 `toolkit`、`daemon-loop`、`ui-panel`、`hybrid` 四类骨架；`daemon-loop` 可使用 timer + LLM 运行自主循环。

### `preset`：思维模式路由

`preset` 不是业务工具，而是影响 agent 如何理解任务、组织思路和保持方向的 agent preset。

当前有三个预设：

- **router-standard**：通用主力，负责任务分类、persona 路由、近距离引导和任务锚定；
- **router-react**：强调“思考 → 行动 → 反馈 → 调整”的循环；
- **router-spec**：强调规格化、深度推理和交付前审查。

`router-standard` 的主要机制包括：

- 根据任务选择 `spec`、`react`、`mixed` 或 `weak` 行为带；
- 根据模型类型选择 persona；
- 从首条真实用户消息开始路由；
- 在每轮用户消息附近加入引导，减少跑题和上下文稀释；
- 用回顾、收敛、反跑题三个锚点保持任务方向；
- 保留 DSH 原有的 plan-mode 边界；
- 提供 `dev_router_status`、`dev_router_mode`、`dev_mode_subagent` 等调节工具。

预设现在以独立 bundle 包装配，不再使用旧的 `.agent-presets` 目录协议。修改预设并同步快照后，需要重启 DSH 才会被启动时读取。

### `graded`：复杂任务协议

`graded` 把复杂任务从“模型自己说完成了”变成有状态、有规格、有审核、有验收的流程：

```text
需求脑暴 → 北极星定稿 → L1 组级规格 → L2 小类规格
→ 完整审核 → 按规格执行 → 打卡 → 组收官 → 终验 → 审计
```

六个主要工具：

| 工具 | 用途 |
| --- | --- |
| `commit_star` | 固化目的、需求、非目标、假设和任务模式 |
| `edit_plan` | 编写 L1 组规格和 L2 小类规格 |
| `lock_stage` | 复检并锁定阶段 |
| `mark_task` | 打卡，作为唯一前进许可 |
| `redteam_verdict` | 对任务进行 `pass` / `reject` 裁决 |
| `revise_do` | 修改执行方式并保留修订轨迹 |

关键约束：先澄清歧义；必须选择 `correct`、`experience` 或 `research` 模式；规格缺字段时拒绝写入；设置 `verify=redteam` 的任务未通过红队不能打卡；状态写入磁盘，重启可恢复；提供 `/graded-mode/api/audit` 和三层任务树面板。

## 2. 安装整套能力

### 推荐方式：安装脚本

```powershell
git clone https://github.com/yjh051108/dsh-routing-suite.git
cd dsh-routing-suite
.\install.ps1
```

安装脚本会装配注入器和三个 router bundle，完成后重启 DSH。

### 手动安装

```powershell
dsh plugin --profile web add .\injector
dsh plugin --profile web add .\preset\router-standard\bundle
dsh plugin --profile web add .\preset\router-react\bundle
dsh plugin --profile web add .\preset\router-spec\bundle
```

如果 `dsh` 不在 PATH：

```powershell
npx '@deepseek-ai/dsh' plugin --profile web add .\injector
```

重启 DSH 后，新会话即可选择 `Router Standard`、`Router React` 或 `Router Spec`。

### 安装 `graded`

```bash
cd graded
npm install
node scripts/build.mjs
# 再将构建目录或 tgz 交给 dsh plugin --profile web add
```

也可以直接使用发布的 `graded` tgz 包。安装完成后重启 DSH。

> 不要把预设复制到 `~/.dsh/.agent-presets/`。当前 harness 已改为通过 Cordis composition 和 profile bundles 注册 preset。

## 3. 日常使用

### 选择思维路由

- 通用开发和稳定收敛：`Router Standard`；
- 频繁执行、观察反馈、再调整：`Router React`；
- 先分析规格、风险和边界：`Router Spec`。

路由预设改变模型的工作方式，不替代具体插件，也不自动完成任务。

### 启用分级模式

在 DSH 会话中输入：

```text
/graded 你的复杂任务
```

关闭：

```text
/graded off
```

也可以在信息充分时直接调用 `commit_star` 激活。它适合跨文件开发、研究、设计、强验收、长流程或需要红队审查的任务；简单问答和小改动不必使用。

### 开发插件并实时迭代

```text
1. dev_scaffold_plugin 生成骨架
2. 编写工具、循环或 UI
3. dev_build_plugin 构建打包
4. dev_inject_plugin 注入当前 DSH
5. 修改代码后再次构建
6. 自动 watch 重载，或调用 dev_reload_package
7. 验证通过后 dev_install_package 正式装配
```

实验工具推荐先走：

```text
dev_stage_add → dev_stage_call → dev_stage_promote
```

## 4. 推荐组合流程

```text
1. injector 装载所需插件
2. preset 选择模型工作方式
3. graded 澄清需求并固化北极星
4. graded 编写规格、验收标准和执行方式
5. 模型按规格执行，通过打卡/红队门
6. injector 在开发中热重载插件
7. graded 做最终验收和审计
```

| 要解决的问题 | 使用组件 |
| --- | --- |
| 插件怎么进入、更新和卸载 | `injector` |
| 模型如何思考和执行 | `preset` |
| 复杂任务如何拆解并证明完成 | `graded` |

## 5. 开发与测试

### preset

编辑不带版本号的源码，验证后同步快照：

```bash
node preset/router-standard/router-bootstrap-v34.selftest.mjs
node preset/scripts/sync-preset.cjs router-standard
node preset/scripts/sync-preset.cjs --all --check
```

然后重启 DSH。`dev_reload_preset` 只检查运行时行，不负责让 bundle patch 当前进程热生效。

### graded

```bash
cd graded
npm install
npm test
node scripts/build.mjs
node scripts/e2e-3.1.mjs
node scripts/e2e-redteam-group.mjs
```

已装配的 `graded` 可使用 `dev_reload_package dsh-graded-mode` 热重载。

## 6. 常见问题

**修改预设后没有生效？** 预设 patch 只在 DSH 启动时读取。同步快照后重启 DSH；`dev_reload_preset` 不负责热重载。

**热重载后出现重复工具或孤儿路由？** 先看 `dev_plugin_status`，必要时调用 `dev_clear_routes`，再执行 `dev_reload_package`。

**如何撤销实验插件？** 使用 `dev_uninject_plugin`，它会清理 host、client、监听器、路由和注入记录。

**`graded` 是否每个任务都必须启用？** 不需要。它面向复杂、长流程、强验收和高风险任务。

## 7. 进一步阅读

- [injector/README.md](injector/README.md)：运行时注入器完整说明
- [preset/README.md](preset/README.md)：思维模式路由预设说明
- [graded/README.md](graded/README.md)：分级协议、工具和测试说明
- [preset/AGENTS.md](preset/AGENTS.md)：预设开发规范
- [docs/PROTOCOL-SYNC-0.2.0-rc.2.md](docs/PROTOCOL-SYNC-0.2.0-rc.2.md)：bundle 协议迁移说明

MIT License。
