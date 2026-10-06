/**
 * Harness 权威接口探测器 —— 契约守卫与接口快照的**唯一**解析实现。
 *
 * 本模块回答一个问题：本机 npm 安装的 DSH 运行时里，某条契约到底长什么样。
 * 它只读文件、只做静态解析，**不 require harness 代码、不启动 DSH、不联网**，
 * 因此可以在任何 CI 或干净 checkout 上跑。
 *
 * 设计约束（工单 01 验收标准）：
 * - 探测逻辑只有一份：`guard/contracts.mjs` 与 `guard/snapshot.mjs` 都从这里取数，
 *   不允许各自写一套解析。
 * - harness 不在本机时，返回 `{ available: false, reason }`，由调用方明确跳过，
 *   而不是把"没探测到"当成"契约满足"。
 *
 * @module probe
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 `<repo>/guard/lib/probe.mjs`）。 */
export const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** 可安装包权威清单在 harness 安装树中的相对路径。 */
const PACKAGES_MD_RELATIVE = join(
	"node_modules",
	"@deepseek-ai",
	"dsh-agent-preset",
	"skills",
	"cordis-composition-reference",
	"references",
	"packages.md",
);

/** 候选根是否像一个 harness 安装：必须同时有 `package.json` 与 `node_modules/@deepseek-ai/`。 */
function looksLikeHarnessRoot(candidate) {
	if (!candidate) return false;
	return (
		existsSync(join(candidate, "package.json")) &&
		existsSync(join(candidate, "node_modules", "@deepseek-ai"))
	);
}

/**
 * 定位 harness 安装根。
 *
 * **显式指定具有权威性**：调用方给了 `explicit`，或环境里设了 `DSH_HARNESS_ROOT`，
 * 就只认这个路径 —— 它不是一个"先试这个、不行再猜"的提示。这一点是刻意的：
 * 把显式路径混进自动探测的候选列表，会让一个**写错的**路径被静默忽略、悄悄回落到
 * 本机真实安装上，于是"harness 不可用"这条分支永远走不到，调用方拿到的是一个
 * 看起来成功的假结果。要能验证跳过逻辑，就必须能真的指定一个空目录。
 *
 * 只有**没有任何显式指定**时，才回落到自动探测。
 *
 * @param {string | undefined} explicit 调用方显式指定的安装根。
 * @returns {{ root: string, available: true } | { root: string, available: false, reason: string, explicit: boolean }}
 */
export function locateHarnessRoot(explicit) {
	const requested = explicit
		? resolve(explicit)
		: process.env.DSH_HARNESS_ROOT
			? resolve(process.env.DSH_HARNESS_ROOT)
			: undefined;
	const via = explicit ? "--harness-root" : "DSH_HARNESS_ROOT";

	if (requested) {
		if (looksLikeHarnessRoot(requested))
			return { root: requested, available: true };
		return {
			root: requested,
			available: false,
			explicit: true,
			reason: `${via} 指定的路径不是一个 DSH harness 安装：${requested}（需要同时存在 package.json 与 node_modules/@deepseek-ai/）。修正该路径，或去掉 ${via} 以回落到自动探测。`,
		};
	}

	const candidates = [
		join(
			process.env.APPDATA ?? "",
			"npm",
			"node_modules",
			"@deepseek-ai",
			"dsh",
		),
		join(
			process.env.HOME ?? "",
			".npm-global",
			"lib",
			"node_modules",
			"@deepseek-ai",
			"dsh",
		),
		"/usr/local/lib/node_modules/@deepseek-ai/dsh",
		"/usr/lib/node_modules/@deepseek-ai/dsh",
	];

	const tried = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		tried.push(candidate);
		if (looksLikeHarnessRoot(candidate))
			return { root: candidate, available: true };
	}

	return {
		root: tried[0] ?? "",
		available: false,
		explicit: false,
		reason: `未在本机找到 DSH harness 安装（试过：${tried.filter(Boolean).join(" | ") || "（无可试路径）"}）。设置 DSH_HARNESS_ROOT 指向安装根，或用 --harness-root 指定。`,
	};
}

/** 读文件，失败返回 `undefined`。 */
function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** 读 JSON，失败返回 `undefined`。 */
function readJson(path) {
	const text = readText(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * 在 harness 安装树中按包名解析一个包的目录。
 *
 * 只认两处（与实测一致）：`<root>/node_modules/@deepseek-ai/<name>`（插件包）与
 * `<root>/node_modules/<name>`（如 `ws`）。
 *
 * @param {string} root harness 安装根。
 * @param {string} packageName 包名（可含 scope 与子路径，子路径会被剥离）。
 * @returns {string | undefined} 包目录的绝对路径。
 */
export function resolvePackageDir(root, packageName) {
	if (!root) return undefined;
	const scopeEnd = packageName.startsWith("@") ? packageName.indexOf("/") : -1;
	const pathEnd = packageName.indexOf("/", scopeEnd + 1);
	const bare = pathEnd === -1 ? packageName : packageName.slice(0, pathEnd);

	const nested =
		scopeEnd === -1
			? join(root, "node_modules", bare)
			: join(
					root,
					"node_modules",
					bare.slice(0, scopeEnd),
					bare.slice(scopeEnd + 1),
				);

	if (existsSync(join(nested, "package.json"))) return nested;
	const flat = join(root, "node_modules", bare);
	if (existsSync(join(flat, "package.json"))) return flat;
	return undefined;
}

/**
 * 列出 harness 安装树里**真实存在**的全部包名。
 *
 * 这是判定「某个 `@deepseek-ai/*` specifier 是不是仓库编造的」的**语义判据**，
 * 取代早先手写的基建包白名单 —— 手写名单追不上 harness 的包增长，每加一个
 * 内部实现包（如 `dsh-util-values`）就要改一次守卫，而漏改的表现是**守卫自己
 * 制造假阳性**，把真实的 harness 内部包报成「不存在的包名」。
 *
 * 覆盖 `<root>/node_modules/` 下的两级 layout：
 * - `@scope/name`（插件包，本仓库关心的全部是这一类）
 * - 顶层裸名（如 `zod`、`ws`）
 *
 * 之所以能这样判：`packages.md` 只列**可安装插件包**，harness 的内部实现包与
 * 第三方传递依赖都不在其中，但它们确实是合法的、可被依赖引用的真实包。
 * 「不在清单」与「不存在」是两件事，只有后者才是违规。
 *
 * @param {string} root harness 安装根。
 * @returns {Set<string>} 包名集合（含 scope，如 `@deepseek-ai/dsh-tools`）。
 */
export function listInstalledPackages(root) {
	/** @type {Set<string>} */
	const names = new Set();
	if (!root) return names;
	// 安装根本身也是一个包（`@deepseek-ai/dsh`），它的名字不会出现在自己的
	// node_modules 下 —— 但仓库在 README / install 脚本里用 `npx @deepseek-ai/dsh`
	// 引用它是完全正确的。所以把根自己读出来放进去。
	const rootName = readJson(join(root, "package.json"))?.name;
	if (typeof rootName === "string" && rootName !== "") names.add(rootName);
	const nodeModules = join(root, "node_modules");
	let topLevel;
	try {
		topLevel = readdirSync(nodeModules, { withFileTypes: true });
	} catch {
		return names;
	}
	for (const entry of topLevel) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (!entry.name.startsWith("@")) {
			names.add(entry.name);
			continue;
		}
		let scoped;
		try {
			scoped = readdirSync(join(nodeModules, entry.name), {
				withFileTypes: true,
			});
		} catch {
			continue;
		}
		for (const inner of scoped) {
			if (!inner.isDirectory() && !inner.isSymbolicLink()) continue;
			names.add(`${entry.name}/${inner.name}`);
		}
	}
	return names;
}

/**
 * 探测 harness 版本与可安装包权威清单。
 *
 * @param {string} root harness 安装根。
 * @returns {object} 快照片段。
 */
export function probeHarness(root) {
	const dshPkg = readJson(join(root, "package.json"));
	// 快照里只留相对路径：绝对路径会让快照绑死本机、并泄露用户目录结构。
	const packagesMdRelative = PACKAGES_MD_RELATIVE.split(sep).join("/");
	const packagesMdPath = join(root, PACKAGES_MD_RELATIVE);
	const packagesMd = readText(packagesMdPath);
	const packages =
		packagesMd === undefined ? undefined : parseInstallablePackages(packagesMd);

	return {
		version: dshPkg?.version,
		packagesMdPath: packagesMdRelative,
		packagesMdAvailable: packagesMd !== undefined,
		packagesMdSha256:
			packagesMd === undefined
				? undefined
				: createHash("sha256").update(packagesMd, "utf8").digest("hex"),
		installablePackages: packages?.names,
		installablePackageCount: packages?.names.length,
		installablePackageGroups: packages?.groups,
		// 接受 `config` 的子集（`packages.md` 第二列 = `Config`）。判「包名是否存在」
		// 用 `installablePackages`；这个只用于报告/后续校验，不参与存在性判定。
		installablePackagesWithConfig: packages?.withConfig,
	};
}

/**
 * 从 `packages.md` 解析可安装包权威清单。
 *
 * 表行格式固定为 ``| `@deepseek-ai/<name>` | yes|no | <描述> |``，由 harness 侧
 * 生成脚本产出并校验（禁止手改）。同时收集 `## <group>` 分组名。
 *
 * 第二列**不是**「能否安装」——文件头原文：「Every package below exports a Cordis
 * plugin that a bundle patch can name in a Loader row. `Config` marks packages whose
 * row accepts a `config` mapping」。即凡是出现在本文件里的包**都是**可装载的，第二列
 * 只说明该行是否接受 `config`。所以本函数把两者都返回：`names` 是**全部**可装载包，
 * `withConfig` 是其中接受 `config` 的子集。判「包名是否存在」必须用 `names`。
 *
 * @param {string} markdown 文件全文。
 * @returns {{ names: string[], withConfig: string[], groups: Record<string, string[]> }}
 */
export function parseInstallablePackages(markdown) {
	/** @type {string[]} */
	const names = [];
	/** @type {string[]} */
	const withConfig = [];
	/** @type {Record<string, string[]>} */
	const groups = {};
	let currentGroup = "(ungrouped)";

	for (const line of markdown.split(/\r?\n/)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			currentGroup = heading[1];
			groups[currentGroup] ??= [];
			continue;
		}
		const row = /^\|\s*`(@deepseek-ai\/[^`]+)`\s*\|\s*(yes|no)\s*\|/.exec(line);
		if (!row) continue;
		names.push(row[1]);
		if (row[2] === "yes") withConfig.push(row[1]);
		groups[currentGroup] ??= [];
		groups[currentGroup].push(row[1]);
	}

	return { names, withConfig, groups };
}

/**
 * 探测 `@deepseek-ai/cordis` 声明的事件名集合。
 *
 * 认 `lib/types/events.d.ts` 里 `export interface Events { ... }` 的成员名。
 * 事件名可以是裸标识符（`ready:`）或字符串字面量（`'internal/plugin':`）。
 *
 * @param {string} root harness 安装根。
 * @returns {object} 快照片段。
 */
export function probeCordisEvents(root) {
	const dir = resolvePackageDir(root, "@deepseek-ai/cordis");
	const eventsPath = dir ? join(dir, "lib", "types", "events.d.ts") : undefined;
	const text = eventsPath ? readText(eventsPath) : undefined;

	if (text === undefined) {
		return {
			available: false,
			reason: "未找到 @deepseek-ai/cordis 的 lib/types/events.d.ts",
			eventsPath: undefined,
		};
	}

	const names = parseEventsInterface(text);
	if (names === undefined) {
		return {
			available: false,
			reason: `在 ${eventsPath} 中未找到 'interface Events' 声明体`,
			eventsPath,
		};
	}

	return {
		available: true,
		eventsPath: relativeTo(root, eventsPath),
		events: [...new Set(names)].sort(),
	};
}

/**
 * 从一段 `.d.ts` 文本里抽 `interface Events { ... }` 的成员名。
 *
 * 事件声明有两种形态，都要认：
 *   `'internal/plugin'(fiber: Fiber): void;`   —— 方法签名式（本版本实际形态）
 *   `ready: void;`                             —— 属性式
 *
 * 注意不能用 `\([^)]*\)` 匹配形参表：`next: () => any` 这种回调形参内部就带括号
 * （早期版本用这个方法，导致 9 个事件只抽出 5 个）。因此只锚定"名字后面必须跟
 * `(` 或 `:`"，不校验形参表的完整形态。
 *
 * 必须逐行处理而不是跨行正则：jsdoc 注释里的 `@param x - y` 之类会被误当事件名。
 *
 * @param {string} text `.d.ts` 文本。
 * @returns {string[] | undefined} 成员名；没有 `interface Events` 时返回 undefined（区别于空接口）。
 */
export function parseEventsInterface(text) {
	const body = extractBraceBody(text, "interface Events");
	if (body === undefined) return undefined;

	return parseTopLevelMembers(body);
}

/**
 * 抽取一段花括号体里**顶层**的成员名（跳过嵌套对象类型字面量里的字段）。
 *
 * 为什么必须做深度判定：事件声明的形参里常内联 payload 类型，例如
 *
 *     'agent/error'(this: Scoped<Agent>, payload: {
 *         agent: Agent;
 *         turn: number;
 *         error: unknown;
 *     }): void;
 *
 * 逐行取「名字 + `(` 或 `:`」会把 `agent`、`turn`、`error` 这些 **payload 字段**
 * 当成事件名收进来 —— 实测会让并集从 90 涨到 123，多出的全是字段名。
 * 因此只在相对体深度 0 处接受成员名。
 *
 * @param {string} body 花括号体（不含外层花括号）。
 * @returns {string[]} 顶层成员名（按出现顺序，含重复）。
 */
export function parseTopLevelMembers(body) {
	const memberPattern =
		/^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?:\(|[?]?\s*:)/;

	// 预处理：把块注释整体抹成空白（保留换行，行号与深度不受影响），
	// 逐字符扫描时再把字符串字面量与行注释跳过，避免花括号被误算。
	const withoutBlockComments = body.replace(/\/\*[\s\S]*?\*\//g, (block) =>
		block.replace(/[^\n]/g, " "),
	);

	const names = [];
	let depth = 0;
	let quote = null;
	let lineStart = 0;
	// 关键：判「本行是不是顶层成员」要用**行首的深度**，而不是行尾的深度。
	// 事件签名常常自带内联 payload 类型，例如
	//
	//     'agent/created'(this: Scoped<Agent>, payload: {
	//
	// 这一行自己就把深度从 0 抬到 1。若在换行处（该行花括号已计入）再判 depth === 0，
	// 事件行会被误判成"嵌在对象类型里"，于是整个事件源被解析成 0 个成员 —— 实测
	// dsh-agent 的 29 个事件就这样全军覆没，并集随之丢掉 agent/pre-step 等合法事件。
	let depthAtLineStart = 0;

	const handleLine = (rawLine, depthOfLineStart) => {
		if (depthOfLineStart !== 0) return;
		const trimmed = rawLine.trim();
		if (trimmed === "" || trimmed.startsWith("//")) return;
		const match = memberPattern.exec(trimmed);
		if (match) names.push(match[1] ?? match[2] ?? match[3]);
	};

	for (let i = 0; i < withoutBlockComments.length; i += 1) {
		const char = withoutBlockComments[i];

		if (char === "\n") {
			handleLine(withoutBlockComments.slice(lineStart, i), depthAtLineStart);
			lineStart = i + 1;
			depthAtLineStart = depth;
			// 行末状态复位：行注释在这里结束。
			quote = null;
			continue;
		}

		if (quote) {
			if (char === "\\") {
				i += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}

		// 行注释：跳到行尾（换行由上面的分支统一处理）。
		if (char === "/" && withoutBlockComments[i + 1] === "/") {
			const newline = withoutBlockComments.indexOf("\n", i);
			if (newline === -1) break;
			i = newline - 1;
			continue;
		}

		// 模板串可能跨行，因此不能像行注释那样简单跳过；按字符串状态处理。
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
	}

	handleLine(withoutBlockComments.slice(lineStart), depthAtLineStart);
	return names;
}

/**
 * 汇总整棵 harness 安装树里**所有**包声明的 `Events` 接口成员（并集）。
 *
 * 为什么不能只读 cordis 核心：cordis 的 `events.d.ts` 只声明 9 个 `internal/*`
 * 事件（框架自身的生命周期钩子）。真实的业务事件由各功能包通过 declaration
 * merging 扩充 `Events` 接口，例如：
 *
 * - `dsh-session/lib/types/index.d.ts`        → `session/event`
 * - `dsh-agent/lib/types/runtime-types.d.ts`  → `agent/pre-step`、`agent/inbox/claimed`
 * - `dsh-llm/lib/types/index.d.ts`            → `llm/stream`
 * - `dsh-system-prompt/lib/types/index.d.ts`  → `system-prompt/assemble`
 *
 * 只读 cordis 核心会把上面这些**合法事件**全部误报成违规。所以守卫必须用并集，
 * 而并集必须从磁盘实测派生（不硬编码），否则 harness 新增事件包时守卫会失效。
 *
 * @param {string} root harness 安装根。
 * @returns {{ available: boolean, reason?: string, scanned: number, sources: Array<{file: string, events: string[]}>, events: string[] }}
 */
export function probeHarnessEvents(root) {
	const scopeRoot = join(root, "node_modules", "@deepseek-ai");
	const files = [];
	collectFiles(scopeRoot, (file) => file.endsWith(".d.ts"), files, 0);

	const sources = [];
	const union = new Set();

	// cordis 核心也在这棵树里（`@deepseek-ai/cordis/lib/types/events.d.ts`），
	// 与其它包一视同仁地被扫到，不特殊处理。
	for (const file of files) {
		const text = readText(file);
		if (text === undefined) continue;
		// 只有真的声明了 `interface Events` 的文件才算事件源；只为拿到判空，
		// 真正的成员抽取交给 parseEventsInterface。
		if (!/interface\s+Events\b/.test(text)) continue;
		const names = parseEventsInterface(text);
		if (!names || names.length === 0) continue;
		const relative = relativeTo(root, file);
		sources.push({ file: relative, events: [...new Set(names)].sort() });
		for (const name of names) union.add(name);
	}

	if (sources.length === 0) {
		return {
			available: false,
			reason: `在 ${scopeRoot} 下没有找到任何声明了 'interface Events' 的 .d.ts`,
			scanned: files.length,
			sources: [],
			events: [],
		};
	}

	sources.sort((a, b) => a.file.localeCompare(b.file));
	return {
		available: true,
		scanned: files.length,
		sources,
		// cordis 核心的 9 个事件必须在内；否则说明并集漏了核心包。
		coreEvents:
			parseEventsInterface(
				readText(join(scopeRoot, "cordis", "lib", "types", "events.d.ts")) ??
					"",
			) ?? [],
		events: [...union].sort(),
	};
}

/**
 * 探测「相对插件行的解析锚点」这一 Loader 契约。
 *
 * 为什么这条契约值得单独探测：本仓库三个 preset 都用**相对路径**声明自己的运行时脚本，
 * 例如 `name: ./router-bootstrap-v34.mjs?v=88`。这类行能否解析，完全取决于 Loader 把
 * `baseUrl` 设在哪儿：
 *
 * - 权威方言说明 `cordis-composition-reference/SKILL.md:18`：「inserted relative paths
 *   are **anchored beside their patch file**」。
 * - 实现：`dsh-app-boot` 用 patch 文件自身路径推导 baseUrl
 *   （`this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href`），
 *   `cordis-plugin-loader` 再用 `new URL(name, this.ctx.baseUrl).href` 解析相对行。
 *
 * 一旦上游把锚点改成 bundle 根或进程 CWD，preset 里的 `.mjs` 行会**静默解析失败**
 * （表现为插件不加载，而不是报错），所以这里把「锚点来自 patch 文件目录」这一事实
 * 固化成可探测项：上游改了，快照 diff 会立刻显形。
 *
 * @param {string} root harness 安装根。
 * @returns {object} 快照片段。
 */
export function probeLoaderResolution(root) {
	const bootDir = resolvePackageDir(root, "@deepseek-ai/dsh-app-boot");
	const bootPath = bootDir ? join(bootDir, "lib", "index.js") : undefined;
	const bootText = bootPath ? readText(bootPath) : undefined;

	const loaderDir = resolvePackageDir(
		root,
		"@deepseek-ai/cordis-plugin-loader",
	);
	const loaderPath = loaderDir ? join(loaderDir, "lib", "index.js") : undefined;
	const loaderText = loaderPath ? readText(loaderPath) : undefined;

	if (bootText === undefined && loaderText === undefined) {
		return {
			available: false,
			reason:
				"既未找到 @deepseek-ai/dsh-app-boot，也未找到 @deepseek-ai/cordis-plugin-loader",
		};
	}

	// `this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href`
	// —— 点号表示「取该文件的父目录」，即锚点 = patch 文件的所在目录。
	const anchorsAtPatchDir =
		bootText !== undefined &&
		/baseUrl\s*=\s*new URL\(\s*["']\.["']\s*,\s*pathToFileURL\(/.test(bootText);
	// 相对行走 `new URL(name, this.ctx.baseUrl).href`。
	const resolvesRelativeAgainstBaseUrl =
		loaderText !== undefined &&
		/new URL\(\s*name\s*,\s*this\.ctx\.baseUrl\s*\)/.test(loaderText);
	// `cordis:` 前缀是内建 builtin，不走 URL 解析。
	const hasCordisBuiltins =
		loaderText !== undefined &&
		/name\.startsWith\(\s*["']cordis:["']\s*\)/.test(loaderText);

	// ★ 根因守卫：`anchorInsertedPluginNames` 的递归条件。
	// 实现（dsh-app-boot）是：
	//   const visit = (entry) => {
	//     if (typeof entry.name === 'string' && (isAbsolute(...) || './' || '../'))
	//       entry.name = pathToFileURL(resolve(base, entry.name)).href
	//     if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
	//   }
	// 即它**只**沿 `group + 数组 config` 下钻。预设的运行时行却嵌在
	// `insert[].config.plugins[].name`（config 是对象、无 group）里 → 永远不被
	// 锚定 → Loader 按 `ctx.baseUrl`（= profile 目录）解析 → ERR_MODULE_NOT_FOUND，
	// 整个预设静默不加载。所以本仓库三个 preset 的运行时行必须是**裸包名子路径**
	// （经 package.json 的 exports 映射解析），这也是官方每个预设补丁的做法。
	// 若上游放宽递归进 config.plugins，这里会漂移 —— 那正是重新评估该约束的时机。
	const anchorsOnlyGroupArrayConfig =
		bootText !== undefined &&
		/entry\.group\s*&&\s*Array\.isArray\(\s*entry\.config\s*\)/.test(bootText);
	const anchorsConfigPlugins =
		bootText !== undefined && /entry\.config\??\.plugins/.test(bootText);

	return {
		available: true,
		bootPath: bootPath === undefined ? undefined : relativeTo(root, bootPath),
		loaderPath:
			loaderPath === undefined ? undefined : relativeTo(root, loaderPath),
		anchorsAtPatchDir,
		resolvesRelativeAgainstBaseUrl,
		hasCordisBuiltins,
		anchorsOnlyGroupArrayConfig,
		anchorsConfigPlugins,
	};
}

/**
 * 探测 `@deepseek-ai/dsh-tools` 的注册路径。
 *
 * 关键问题（审计结论）：`register()` 是否校验 `definition.parameters`？
 * 实测：只对 `output.schema` 调 `assertSupportedJsonSchema`；`parameters` 的 DSL
 * 编译发生在 `defineTool()` 内的 `parameterSchemaSpecToJsonSchema`。
 *
 * @param {string} root harness 安装根。
 * @returns {object} 快照片段。
 */
export function probeDshToolsRegister(root) {
	const dir = resolvePackageDir(root, "@deepseek-ai/dsh-tools");
	const indexPath = dir ? join(dir, "lib", "index.js") : undefined;
	const text = indexPath ? readText(indexPath) : undefined;

	if (text === undefined) {
		return {
			available: false,
			reason: `未找到 ${indexPath ?? "@deepseek-ai/dsh-tools"}`,
			indexPath,
		};
	}

	const registerBody = extractMethodBody(text, "register(");
	const defineToolBody = extractFunctionBody(text, "function defineTool(");

	const registerValidatesOutputSchema =
		registerBody !== undefined &&
		/assertSupportedJsonSchema\s*\(\s*output\.schema\s*\)/.test(registerBody);
	const registerValidatesParameters =
		registerBody !== undefined &&
		/assertSupportedJsonSchema\s*\(\s*(?:definition\.)?parameters\s*\)/.test(
			registerBody,
		);
	const defineToolCompilesParameters =
		defineToolBody !== undefined &&
		/parameterSchemaSpecToJsonSchema\s*\(\s*options\.parameters\s*\)/.test(
			defineToolBody,
		);

	return {
		available: true,
		indexPath: relativeTo(root, indexPath),
		registerValidatesOutputSchema,
		registerValidatesParameters,
		defineToolCompilesParameters,
	};
}

/**
 * 探测 `@deepseek-ai/dsh-client-modules` 的公开方法面。
 *
 * 公开面 = `lib/index.js` 中 `ClientModuleRegistry` 的**非 `private`** 实例成员。
 * 判定方式：在 `class ... extends Service {` 块内，取缩进一级的成员声明，
 * 排除 `private` 修饰符所在的那一行以及 `static`。
 *
 * @param {string} root harness 安装根。
 * @returns {object} 快照片段。
 */
export function probeClientModulesMethods(root) {
	const dir = resolvePackageDir(root, "@deepseek-ai/dsh-client-modules");
	const typesPath = dir ? join(dir, "lib", "types", "index.d.ts") : undefined;
	const text = typesPath ? readText(typesPath) : undefined;

	if (text === undefined) {
		return {
			available: false,
			reason: `未找到 ${typesPath ?? "@deepseek-ai/dsh-client-modules"}`,
			typesPath,
		};
	}

	return {
		available: true,
		typesPath: relativeTo(root, typesPath),
		class: "ClientModuleRegistry",
		...parseClassMembers(text, "ClientModuleRegistry"),
	};
}

/**
 * 从 `.d.ts` 解析一个类的公开/私有成员名。
 *
 * **为什么读 `.d.ts` 而不是 `lib/index.js`**：发布的 `lib/index.js` 已经过 esbuild
 * 降级，`private` 修饰符被完全抹除，运行时 JS 里无法区分公开面与内部实现。`.d.ts`
 * 是 TypeScript 源码的真实投影，保留了 `private`，因此它才是公开面的权威来源。
 *
 * 判定规则：类体内每个成员声明行，去掉可选的前置 jsdoc，看是否以 `private` 开头。
 * `static` 成员不计入实例公开面。getter 记其名字。
 *
 * @param {string} text `.d.ts` 全文。
 * @param {string} className 类名。
 * @returns {{ publicMethods: string[], privateMembers: string[] }}
 */
export function parseClassMembers(text, className) {
	const body = extractClassBody(text, className);
	if (body === undefined) return { publicMethods: [], privateMembers: [] };

	/** @type {string[]} */
	const publicMethods = [];
	/** @type {string[]} */
	const privateMembers = [];

	// 去掉块注释，保留行结构，避免 jsdoc 正文被当作成员。
	const stripped = body.replace(/\/\*[\s\S]*?\*\//g, (block) =>
		block.replace(/[^\n]/g, " "),
	);

	for (const rawLine of stripped.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("//")) continue;
		if (line.startsWith("static ")) continue;

		const isPrivate = /^private\b/.test(line);
		const rest = isPrivate ? line.replace(/^private\b\s*/, "") : line;
		// `declare` 只出现在类型投影里，剥掉后取成员名。
		const cleaned = rest.replace(/^(?:declare|readonly|abstract)\s+/, "");
		const match =
			/^(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)\s*[(<:;=]/.exec(cleaned);
		if (!match) continue;
		const name = match[1];
		const bucket = isPrivate ? privateMembers : publicMethods;
		if (!bucket.includes(name)) bucket.push(name);
	}

	return {
		publicMethods: publicMethods.sort(),
		privateMembers: privateMembers.sort(),
	};
}

/**
 * 探测 `@deepseek-ai/dsh-tools` 是否导出 `unregister`（服务级注销方法）。
 *
 * @param {string} root harness 安装根。
 * @returns {object}
 */
export function probeToolDisposal(root) {
	const dir = resolvePackageDir(root, "@deepseek-ai/dsh-tools");
	const indexPath = dir ? join(dir, "lib", "index.js") : undefined;
	const text = indexPath ? readText(indexPath) : undefined;
	if (text === undefined)
		return {
			available: false,
			reason: `未找到 ${indexPath ?? "@deepseek-ai/dsh-tools"}`,
		};

	const exportsLine =
		text.split(/\r?\n/).find((line) => line.startsWith("export {")) ?? "";
	const registryBody = extractClassBody(text, "ToolRuntime");
	const serviceHasUnregister =
		registryBody !== undefined && /^\tunregister\s*\(/m.test(registryBody);

	return {
		available: true,
		indexPath: relativeTo(root, indexPath),
		exportsUnregister: /\bunregister\b/.test(exportsLine),
		serviceHasUnregister,
	};
}

/**
 * 扫描仓库源码中出现的 `@deepseek-ai/*` specifier 及其出现位置。
 *
 * 跳过：`node_modules`、`.git`、`.scratch`、构建产物目录、`graphify-out`、`guard`。
 * 每个命中给出 `file`（仓库相对、POSIX 分隔）、`line`、`specifier`。
 *
 * `guard/` 之所以跳过：守卫自身与它生成的快照/台账里出现的包名是**说明性引用**
 * （例如「`X` 已被取代」「工单 06 负责修 `Y`」），不是在 import 或依赖声明里引用；
 * `guard/snapshot.json` 里的键更是 harness 安装树的路径，不属于本仓库。把它们一并
 * 当成违规会造成守卫自命中的死循环。
 *
 * @param {string} root 仓库根。
 * @param {object} [options]
 * @param {string[]} [options.skipDirs] 额外跳过的目录名。
 * @param {string[]} [options.skipPaths] 额外跳过的**仓库相对路径**（目录），如 `injector/lib`。
 * @returns {Array<{file: string, line: number, specifier: string, text: string}>}
 */
export function scanRepoSpecifiers(root, options = {}) {
	const skip = new Set([
		"node_modules",
		".git",
		".scratch",
		"graphify-out",
		"dist",
		"lib",
		".tmp",
		"coverage",
		"guard",
		...(options.skipDirs ?? []),
	]);
	const extensions = new Set([
		".ts",
		".tsx",
		".js",
		".mjs",
		".cjs",
		".json",
		".yml",
		".yaml",
		// 刻意**不含** `.md`：markdown 是散文，没有"可被解析的 specifier 位置"。
		// 文档里点名一个包（尤其为了记录"这个名字是错的、已删除"）不构成依赖声明，
		// 而这条守卫要拦的是"写了却装不上"的**载荷**名——docs/ 下的迁移文档
		// 正是这种写法，早期把它扫进来会报出假阳性。
		".ps1",
		".sh",
	]);
	/** @type {Array<{file: string, line: number, specifier: string, text: string}>} */
	const hits = [];

	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (skip.has(entry.name)) continue;
			const full = join(dir, entry.name);
			// 只按**目录名**跳过是不够的：`injector/lib/` 是构建产物，但 `guard/lib/` 是守卫
			// 自己的源码。用相对路径再判一次，才能表达「跳过 injector/lib 但保留 guard/lib」。
			if (entry.isDirectory() && isSkippedPath(root, full, options.skipPaths))
				continue;
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const dot = entry.name.lastIndexOf(".");
			if (dot === -1 || !extensions.has(entry.name.slice(dot))) continue;
			const text = readText(full);
			if (text === undefined) continue;
			const relative = full
				.slice(root.length + 1)
				.split("\\")
				.join("/");
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i += 1) {
				for (const match of lines[i].matchAll(
					/@deepseek-ai\/[a-z0-9][a-z0-9._/-]*/g,
				)) {
					hits.push({
						file: relative,
						line: i + 1,
						specifier: match[0],
						text: lines[i].trim(),
					});
				}
			}
		}
	};

	walk(root);
	return hits;
}

/**
 * 扫描仓库内**包元数据里的路径引用**，判断它们是否悬空。
 *
 * 背景（工单 09）：`graded/package.json` 曾声明 `types: "./lib/types/index.d.ts"`，
 * 而构建脚本只做文件复制、**从不生成声明文件** —— 于是这个字段指向一个永远不存在的
 * 路径，TypeScript 消费者拿到的是悬空引用。这类缺陷的共同特征是「看起来在起作用，
 * 实际一碰就碎」，所以可以机械化检出：**元数据里出现的路径，解析后必须真实存在**。
 *
 * 扫描面（仅「指向仓库内文件」的字段；指向外部目标的 URL / 包名不算）：
 * - `main` / `module` / `types` / `typings` / `browser` / `unpkg` / `jsdelivr`（顶层与 `exports` 内）
 * - `exports` 里的每个字符串值（含条件导出 `"."` 下的 `types`/`import`/`require` 等）
 * - `bin` 的每个值、`files` 的每一项（`files` 用 glob，只判前缀目录）
 *
 * 跳过项（避免假阳性）：
 * - 以 `./` 开头但不是相对路径意义的（如 `node:` 内置模块）——按是否以 `.` 开头判
 * - 含 `*` 的 glob（`files` 例外，按 glob 前缀判）
 * - 目录型 entry 以 `/` 结尾的导出（`"./sub/"`），解析为目录存在性
 *
 * @param {string} root 仓库根（绝对）。
 * @returns {{entries: Array<{file: string, field: string, target: string, exists: boolean}>}}
 */
export function probePackageMetadataPaths(root) {
	/** 承载「路径指向仓库内文件」的顶层字段（值必须是字符串）。 */
	const singlePathFields = [
		"main",
		"module",
		"types",
		"typings",
		"browser",
		"unpkg",
		"jsdelivr",
	];
	/** 值必须是「路径 → 字符串」映射的字段。 */
	const mapPathFields = ["bin"];

	/** @type {Array<{file: string, field: string, target: string, exists: boolean}>} */
	const entries = [];

	/** 收集 `exports` 里的全部字符串叶子（含条件对象嵌套）。 */
	const collectExportStrings = (value, trail, into) => {
		if (typeof value === "string") {
			into.push({ field: `exports${trail}`, target: value });
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) =>
				collectExportStrings(item, `${trail}[${index}]`, into),
			);
			return;
		}
		if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				collectExportStrings(child, `${trail}.${key}`, into);
			}
		}
	};

	/** 判断一个元数据路径是否指向仓库内文件；不是则返回 null（跳过）。 */
	const localTarget = (target) => {
		if (typeof target !== "string" || target.length === 0) return null;
		// 只有 `./x` / `../x` / `x/y` 这种相对写法才指向包内文件。
		// `node:fs`、`https://…`、`@scope/pkg` 都不是本守卫的对象。
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
		if (!target.startsWith(".") && !target.includes("/")) return null;
		if (target.startsWith("@") || /^[a-z0-9-]+$/i.test(target)) return null;
		return target;
	};

	// 谓词必须同时收「根 package.json」（无目录前缀）与各级子包。
	// 早期只写 `p.endsWith("/package.json")`，于是**根 package.json 从不被审**：
	// 它的 `types` 曾长期指向不存在的 `./injector/lib/types/index.d.ts`，
	// 而守卫始终报 clean —— 审不到就是最坏的假阴性。
	for (const file of findRepoFiles(
		root,
		(p) => p === "package.json" || p.endsWith("/package.json"),
	)) {
		const absolute = join(root, file.split("/").join("\\"));
		const json = readJson(absolute);
		if (!json || typeof json !== "object") continue;
		const baseDir = file.includes("/")
			? file.slice(0, file.lastIndexOf("/"))
			: ".";

		/** @type {Array<{field: string, target: string}>} */
		const candidates = [];

		for (const field of singlePathFields) {
			const target = localTarget(json[field]);
			if (target !== null) candidates.push({ field, target });
		}
		for (const field of mapPathFields) {
			const value = json[field];
			if (value && typeof value === "object" && !Array.isArray(value)) {
				for (const [key, target] of Object.entries(value)) {
					const local = localTarget(target);
					if (local !== null)
						candidates.push({ field: `${field}.${key}`, target: local });
				}
			}
		}
		const exportStrings = [];
		collectExportStrings(json.exports, "", exportStrings);
		for (const { field, target } of exportStrings) {
			const local = localTarget(target);
			if (local !== null) candidates.push({ field, target: local });
		}
		// `files` 是 glob 列表：只判其**字面前缀目录**存在（`lib/**` → `lib`）。
		if (Array.isArray(json.files)) {
			for (const pattern of json.files) {
				if (typeof pattern !== "string") continue;
				const head = pattern.split("*")[0].replace(/\/+$/, "");
				if (head === "" || head.startsWith("!") || head.startsWith("#"))
					continue;
				const local = localTarget(head);
				if (local !== null) candidates.push({ field: "files", target: local });
			}
		}

		for (const { field, target } of candidates) {
			// 含 `*` 时按 glob 前缀判（`files` 已在上面削过，这里兜其余字段）。
			const clean = target.replace(/[*].*$/, "").replace(/\/+$/, "");
			if (clean === "" || clean.startsWith("//")) continue;
			const resolved = resolve(root, baseDir, clean);
			entries.push({
				file,
				field,
				target,
				exists: existsSync(resolved),
				line: locateFieldLine(absolute, field, target),
			});
		}
	}

	return { entries };
}

/**
 * 在 `package.json` 原文里定位某个字段所在行，用于让违规报告给出**可跳转的行号**。
 *
 * 为什么值得单独做：本守卫的其余违规都报 `file:line`，只有它原本报
 * `injector/package.json → \`types\``（有字段名、没有行号）。字段名在长 `exports`
 * 树里不足以定位 —— 同名的 `types` 可能出现在多个条件分支下，而`exports..types`
 * 这种字段路径并不是能在文件里搜到的字面量。
 *
 * 定位策略（按可靠性从高到低）：
 * 1. **按值定位**：`target` 是文件里真实存在的字符串字面量，用它搜行号最准。
 *    同一个值可能出现多次（如 `./cordis.patch.yml` 在 `exports` 与 `files` 里都有），
 *    此时取**第一次**出现的位置 —— 对「这个包声明了这个路径」这件事，首现位置就是
 *    最该指的地方。
 * 2. 值搜不到时（理论上不该发生）退回 `undefined`，由调用方省略行号。
 *
 * @param {string} absolute package.json 的绝对路径。
 * @param {string} field 字段路径（如 `types`、`exports..types`），仅用于兜底。
 * @param {string} target 字段的值（路径字面量）。
 * @returns {number | undefined} 1-based 行号；定位不到时 `undefined`。
 */
function locateFieldLine(absolute, field, target) {
	const text = readText(absolute);
	if (text === undefined) return undefined;
	const lines = text.split(/\r?\n/);

	// 优先按值定位：JSON 里这个路径一定是带引号的字面量。
	const needle = JSON.stringify(target);
	const byValue = lines.findIndex((line) => line.includes(needle));
	if (byValue !== -1) return byValue + 1;

	// 兜底：按字段名定位。取字段路径的最后一段（`exports..types` → `types`）。
	const leaf = field.split(".").pop() ?? field;
	const byField = lines.findIndex((line) =>
		line.includes(JSON.stringify(leaf)),
	);
	if (byField !== -1) return byField + 1;

	return undefined;
}

/**
 * 定位仓库内的文件（跳过 node_modules/.git/.scratch）。
 *
 * @param {string} root 仓库根。
 * @param {(file: string) => boolean} predicate 接收 POSIX 相对路径。
 * @returns {string[]} 匹配文件的 POSIX 相对路径。
 */
export function findRepoFiles(root, predicate) {
	const skip = new Set([
		"node_modules",
		".git",
		".scratch",
		"graphify-out",
		".tmp",
		"coverage",
	]);
	/** @type {string[]} */
	const found = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (skip.has(entry.name)) continue;
			const full = join(dir, entry.name);
			// 构建产物目录按**相对路径**跳过（与 scanRepoSpecifiers 同一判据）。
			// 只按目录名判会漏掉 `injector/lib/`（它不在 skip 名字集里），于是这份过期的
			// 构建副本会被当源码审 —— 同一份缺陷在两处报数，掩盖真实待修数量。
			if (entry.isDirectory() && isSkippedPath(root, full)) continue;
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				const relative = full
					.slice(root.length + 1)
					.split("\\")
					.join("/");
				if (predicate(relative)) found.push(relative);
			}
		}
	};
	walk(root);
	return found.sort();
}

/** 读仓库内文本文件，失败返回 `undefined`。 */
export function readRepoFile(relativePath) {
	const absolute = join(repoRoot, relativePath.split("/").join("\\"));
	try {
		if (!statSync(absolute).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return readText(absolute);
}

/** 读仓库内 JSON 文件，失败返回 `undefined`。 */
export function readRepoJson(relativePath) {
	const text = readRepoFile(relativePath);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * 抽取 `class <name> ... {` 花括号体（不含外层花括号）。缺引号/尖括号平衡感知：
 * 会跳过字符串字面量与行注释中的花括号。
 *
 * @param {string} text 源码。
 * @param {string} className 类名。
 * @returns {string | undefined}
 */
export function extractClassBody(text, className) {
	// 两种形态都要认：
	//   `class Foo extends Bar {`（TS/原生 class 声明）
	//   `var Foo = class extends Bar {`（esbuild/tsdown 降级后的匿名类表达式）
	const declaration = new RegExp(
		`(?:\\bclass\\s+${escapeRegExp(className)}\\b|\\b${escapeRegExp(className)}\\s*=\\s*class\\b)[^{]*\\{`,
	);
	const match = declaration.exec(text);
	if (!match) return undefined;
	return extractBalanced(text, match.index + match[0].length - 1);
}

/**
 * 抽取名为 `<name>` 的方法体（含花括号）。
 *
 * @param {string} text 源码。
 * @param {string} signature 形如 `register(` 的方法签名前缀。
 * @returns {string | undefined}
 */
export function extractMethodBody(text, signature) {
	const pattern = new RegExp(
		`(?:^|\\n)\\s*${escapeRegExp(signature)}[^)]*\\)\\s*\\{`,
	);
	const match = pattern.exec(text);
	if (!match) return undefined;
	const open = text.indexOf("{", match.index + match[0].length - 1);
	return extractBalanced(text, open);
}

/**
 * 抽取 `function <name>` 的函数体（含花括号）。
 *
 * @param {string} text 源码。
 * @param {string} signature 形如 `function defineTool(`。
 * @returns {string | undefined}
 */
export function extractFunctionBody(text, signature) {
	const pattern = new RegExp(`${escapeRegExp(signature)}[^)]*\\)\\s*\\{`);
	const match = pattern.exec(text);
	if (!match) return undefined;
	const open = text.indexOf("{", match.index + match[0].length - 1);
	return extractBalanced(text, open);
}

/**
 * 抽取 `interface <name> { ... }` 的花括号体（不含外层花括号）。
 *
 * @param {string} text 源码。
 * @param {string} signature 形如 `interface Events`。
 * @returns {string | undefined}
 */
export function extractBraceBody(text, signature) {
	const pattern = new RegExp(`${escapeRegExp(signature)}\\s*\\{`);
	const match = pattern.exec(text);
	if (!match) return undefined;
	return extractBalanced(text, match.index + match[0].length - 1);
}

/**
 * 从 `openIndex` 处的 `{` 起，返回配平内容（不含外层花括号）。
 * 感知单/双引号、模板串与行注释。
 *
 * @param {string} text 源码。
 * @param {number} openIndex `{` 的下标。
 * @returns {string | undefined}
 */
function extractBalanced(text, openIndex) {
	if (openIndex < 0 || text[openIndex] !== "{") return undefined;
	let depth = 0;
	let quote = null;
	for (let i = openIndex; i < text.length; i += 1) {
		const char = text[i];
		if (quote) {
			if (char === "\\") {
				i += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === "/" && text[i + 1] === "/") {
			const newline = text.indexOf("\n", i);
			if (newline === -1) break;
			i = newline;
			continue;
		}
		if (char === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end === -1) break;
			i = end + 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(openIndex + 1, i);
		}
	}
	return undefined;
}

/** 正则字面量转义。 */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 递归收集目录下满足条件的文件（绝对路径）。
 *
 * @param {string} dir 起始目录。
 * @param {(file: string) => boolean} predicate 接收绝对路径。
 * @param {string[]} into 结果累加数组。
 * @param {number} depth 当前深度（防止符号链接环导致无限递归）。
 * @param {number} [maxDepth] 最大深度，默认 8。
 */
function collectFiles(dir, predicate, into, depth, maxDepth = 8) {
	if (depth > maxDepth) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			// 依赖目录下再嵌依赖（npm 的嵌套安装）也要钻，否则会漏掉事件包。
			collectFiles(full, predicate, into, depth + 1, maxDepth);
			continue;
		}
		if (!entry.isFile()) continue;
		if (predicate(full)) into.push(full);
	}
}

/**
 * 求 `file` 相对 `base` 的路径，统一为 POSIX 分隔，便于跨平台稳定输出。
 *
 * @param {string} base 基准目录（绝对）。
 * @param {string} file 目标文件（绝对）。
 * @returns {string}
 */
function relativeTo(base, file) {
	const normalizedBase =
		base.endsWith("\\") || base.endsWith("/") ? base : `${base}\\`;
	const relative = file.startsWith(normalizedBase)
		? file.slice(normalizedBase.length)
		: file;
	return relative.split("\\").join("/");
}

/** 仓库内以「构建产物、不该被扫描」著称的目录（仓库相对路径，POSIX 分隔）。 */
const SKIP_PATHS = [
	"injector/lib",
	"injector/dist",
	"graded/lib",
	"preset/dist",
];

/**
 * 判断一个目录是否应被扫描跳过（按**仓库相对路径**，不是目录名）。
 *
 * 为什么不只用目录名：`lib` 这个目录名在本仓库里含义分裂 —— `injector/lib` 是
 * tsdown 的构建产物（`.gitignore` 里明确忽略），而 `guard/lib` 是守卫自己的源码。
 * 早期版本的跳过集里两者都只靠名字判断，于是 `lib` 一被加进跳过名单，
 * `injector/lib/index.js` 这份**过期的构建副本**就重新进入扫描范围：
 *
 * - `client-modules-public-surface` 因此在同一份过期产物上报了 14 条重复违规；
 * - `installable-package-names` 也会去审一份用户不一定存在的构建副本。
 *
 * 这会把「守卫报出的违规数」和「要修的真实缺陷数」脱钩。所以按相对路径判：
 * 精确跳过构建产物目录，其余 `lib/` 目录（如 `guard/lib`）照常扫。
 *
 * @param {string} root 仓库根（绝对）。
 * @param {string} dir 目标目录（绝对）。
 * @param {string[]} [extra] 调用方额外指定的相对路径。
 * @returns {boolean}
 */
function isSkippedPath(root, dir, extra) {
	const relative = relativeTo(root, dir).replace(/\/$/, "");
	const candidates =
		extra === undefined ? SKIP_PATHS : [...SKIP_PATHS, ...extra];
	return candidates.some(
		(path) => relative === path || relative.startsWith(`${path}/`),
	);
}

/**
 * 一次探测全部契约。守卫与快照都调用它，保证只有一份解析。
 *
 * @param {object} [options]
 * @param {string} [options.harnessRoot] 显式 harness 安装根。
 * @param {string} [options.repoRoot] 显式仓库根（默认本文件推导值）。
 * @returns {object} 完整探测结果。
 */
export function probeAll(options = {}) {
	const repo = options.repoRoot ? resolve(options.repoRoot) : repoRoot;
	const located = locateHarnessRoot(options.harnessRoot);

	if (!located.available) {
		return {
			repoRoot: repo,
			harness: { available: false, root: located.root, reason: located.reason },
			// 元数据路径探测**不依赖 harness**，两个分支都要挂 —— 否则一台没装 harness
			// 的机器上，「元数据里不得有悬空路径」这条与 harness 无关的契约会静默消失
			// （表现得像"通过"，实际是从未断言过）。
			packageMetadata: probePackageMetadataPaths(repo),
		};
	}

	return {
		repoRoot: repo,
		harness: {
			available: true,
			root: located.root,
			...probeHarness(located.root),
			// 安装树里真实存在的全部包名。`installable-package-names` 守卫用它来区分
			// 「仓库编造了一个不存在的包名」（真违规）与「引用了 harness 的内部实现包或
			// 第三方传递依赖」（合法，只是不在可安装插件清单里）。
			installedPackages: [...listInstalledPackages(located.root)],
		},
		// 注意：元数据路径探测**不依赖 harness**，所以它同时挂在「harness 可用」与
		// 「harness 不可用」两个返回分支上 —— 否则一台没装 harness 的机器上，
		// 「元数据里不得有悬空路径」这条与 harness 无关的契约会被静默跳过。
		packageMetadata: probePackageMetadataPaths(repo),
		cordisEvents: probeCordisEvents(located.root),
		harnessEvents: probeHarnessEvents(located.root),
		dshToolsRegister: probeDshToolsRegister(located.root),
		toolDisposal: probeToolDisposal(located.root),
		clientModules: probeClientModulesMethods(located.root),
		loaderResolution: probeLoaderResolution(located.root),
		repoSources: {
			specifiers: scanRepoSpecifiers(repo),
		},
	};
}
