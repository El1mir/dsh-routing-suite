# CLAUDE.md

本仓库的开发约定。领域词汇与决策记录见下方「Agent skills」指向的文件。

## 交互要求

所有思考和交流请使用中文，多和用户交流，需要向用户提问的问题调用askuser询问

## 仓库结构

`dsh-routing-suite` 是三个组件的分发入口（各组件均为仓库内普通目录，非 submodule）：

| 目录 | 内容 | 版本 |
| --- | --- | --- |
| `injector/` | DSH 超级模组注入器（运行时注入，免重启） | v0.3.0 |
| `preset/` | 思维模式路由预设（`router-standard` v34 / `router-react` v17 / `router-spec` v10） | v0.3.0 |
| `graded/` | 分级任务协议插件（会话级两级计划 + 红队门 + 审计端点） | 0.0.1-rc1 |

`preset/AGENTS.md` 是 preset 子目录的专项开发指南（编辑基准 / selftest / 同步 / reload 链路），改动 preset 前必读。

## 开发链路（preset）

```text
改源码（无版本别名） → selftest 就地验证 → sync-preset.cjs → 运行目录（版本快照）→ dev_reload_preset → DSH 生效
```

- 编辑对象是 `preset/router-standard/router-bootstrap.mjs`、`router-core.mjs`、`agent.cordis.yml`；带 `-v34` 的文件是同步生成的快照，不要手改。
- 验证：`node preset/router-standard/router-bootstrap-v34.selftest.mjs` → `SELFTEST PASS`。
- 同步：`node scripts/sync-preset.cjs router-standard [--bump]`；改了 `.yml` 或需 DSH 加载新代码时必须 `--bump`。
- DSH 按 URL 缓存 ESM，原地覆盖不生效，需 `dev_reload_preset <preset>` 绕缓存。

## 环境注意

- `gh` / `glab` CLI 在本机未安装；历史 issue 号（如 `#13`、`#76`）出现在提交信息与文档里，指 GitHub `yjh051108/dsh-routing-suite` 的 issue。
- `.dsh` 根目录曾错位：DSH 真实 profile/运行目录在 `C:\Users\Eldwen`，而 shell 的 `USERPROFILE` 指 `Administrator`（详见 `preset/AGENTS.md` 关键坑）。

## Agent skills

### Issue tracker

Issues 与规格以 GitHub issue 形式存放在本仓库（用 `gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个规范名 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：仓库根一份 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。