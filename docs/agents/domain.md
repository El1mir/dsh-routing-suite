# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is **single-context**:

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
├── injector/src/
├── preset/router-standard/
└── graded/src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```text
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## 本仓库的领域词汇起点

`GLOSSARY.md` 尚未创建（由 `/domain-modeling` 按需惰性生成）。在此之前，以下是本仓库已固定使用的术语，**不要另造同义词**（详见根目录 `CLAUDE.md` 与 `preset/AGENTS.md`）：

| 术语 | 含义 |
| --- | --- |
| injector / 注入器 | `injector/`：运行时把本地插件包注入运行中的 DSH web，不碰 patch / package.json / bundles、不重启 |
| preset / 路由预设 | `preset/`：任务感知的思维模式路由（`router-standard` v34 主力 / `router-react` v17 / `router-spec` v10） |
| graded / 分级模式 | `graded/`：会话级两级任务协议（脑暴 → 规格化 L1/L2 → 审核 → 执行 → 组收官 → 终验） |
| 源码（无版本别名） | 编辑基准：`router-bootstrap.mjs` / `router-core.mjs`；带 `-v34` 的是同步生成的快照 |
| 装配位置 | `preset/<name>/bundle/`：独立 npm 包（`dsh.bundle.patch` 声明），由 `dsh plugin --profile web add` 装配成 junction 链；旧的 `~/.dsh/.agent-presets/<preset>/` 目录协议已废弃 |
| 打卡（mark_task） | graded 里唯一的前进许可；`verify=redteam` 的小类未裁决通过不得打卡 |
| 北极星（star / commit_star） | graded 定稿：目的宣言 / 需求 / 非目标 / 假设，执行注入按其锚定 |
| B196 | 提交信息里的裸名包修复批次号（`cordis`/`schemastery` 改 scoped），非 GitHub issue |