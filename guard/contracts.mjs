/**
 * 契约守卫 —— 一条命令跑完，退出码反映是否有守卫失败。
 *
 * 用法：
 *   node guard/contracts.mjs                 # 人类可读报告
 *   node guard/contracts.mjs --json           # 机器可读
 *   node guard/contracts.mjs --harness-root <path>
 *
 * 退出码：0 = 无阻断失败（可能含 report-only 违规）；1 = 有阻断失败；2 = 探测不可用
 * （harness 缺失 / 权威文件读不到），此时**不算通过**，也不算违规。
 *
 * 守卫分两档（工单 01 要求「对仓库里尚未触及的旧写法只报告不阻断」）：
 * - `blocking`：仓库已被工单修好、必须保持不漂移的契约。违反 → 退出码 1。
 * - `report-only`：已知的、由其它工单（02–11）负责修复的旧写法。违反 → 打印但不阻断，
 *   一旦对应工单落地（守卫改为 blocking，或 `resolvedWhen` 条件满足）即自动转为阻断。
 *
 * 探测逻辑全部来自 `guard/lib/probe.mjs`（唯一实现），本文件只做「拿探测结果对契约」。
 *
 * @module contracts
 */

import {
	findRepoFiles,
	probeAll,
	readRepoFile,
	readRepoJson,
	repoRoot as defaultRepoRoot,
} from "./lib/probe.mjs";

/** 基线版本：仓库当前对齐的 DSH harness 版本。 */
const BASELINE_HARNESS_VERSION = "0.2.0-rc.2";

/**
 * 已落地的工单（`guard/tickets.json` 的 `done` 列表）。
 *
 * 工单 01 要求：「守卫对仓库里尚未触及的旧写法只报告不阻断（避免在修复完成前让整条
 * 流水线红掉），而对应工单落地后自动转为阻断。」
 *
 * 实现方式：
 * - 每条违规会带上 `owner`（负责修它的工单号，见下面的 `OWNED_VIOLATIONS`）。
 * - `owner` **不在**本集合里 → 该违规按 report-only 处理（打印 WARN，不阻断）。
 * - `owner` **在**本集合里 → 该违规转为 blocking（说明工单已声称修完，但违规还在，
 *   即修复不完整或发生了回退，必须挡住）。
 * - 没有 `owner` 的违规（守卫自身的契约前提失效、新引入的包名等）一律 blocking。
 *
 * 这样「转阻断」是自动的：工单落地时把它加进 `guard/tickets.json` 的 `done`，
 * 不需改守卫代码。反过来，旧写法被删掉后守卫自然变绿，也不需改代码。
 */
/** 工单清单文件（仓库相对）。 */
const TICKETS_RELATIVE = "guard/tickets.json";

const DONE_TICKETS = loadDoneTickets();

/**
 * 读工单清单里已落地的工单号。
 *
 * 文件不存在或读不动时返回空集合 —— 那意味着「所有工单都还没落地」，于是所有带
 * 归属的违规都按 report-only 处理。这是安全的默认：守卫不会因为票据文件缺失而
 * 把整条流水线误判成红的。
 *
 * @returns {Set<string>} 已落地工单号（如 `'02'`）。
 */
function loadDoneTickets() {
	const json = readRepoJson(TICKETS_RELATIVE);
	const done = json?.done;
	return new Set(Array.isArray(done) ? done.map((v) => String(v)) : []);
}

/**
 * 一条守卫。
 *
 * @typedef {object} Guard
 * @property {string} id 稳定标识（用于 --json 与文档引用）。
 * @property {string} contract 被守护的契约（失败输出第 1 项）。
 * @property {string} expected 期望写法（失败输出第 3 项）。
 * @property {'blocking' | 'report-only'} severity 违反是否阻断。
 * @property {(probe: object) => ({ ok: boolean, violations?: Array<{where: string, detail: string}>, skip?: string })} check
 */

/** @type {Guard[]} */
const guards = [
	{
		id: "cordis-event-names",
		contract:
			"cordis 事件名必须来自 harness 的 Events 接口（cordis 核心 + 各功能包 declaration merging 的并集）；`dispose` 不存在",
		expected:
			"只监听 Events 接口里声明的事件。要清理资源请返回 disposer 或监听真实的生命周期事件，不要写 `ctx.on('dispose', ...)` —— 该事件在 cordis 里不存在，回调永远不会被调用。",
		severity: "blocking",
		check(probe) {
			const core = probe.cordisEvents;
			const union = probe.harnessEvents;
			if (!union?.available) {
				return {
					ok: true,
					skip: `harness 事件集合不可探测：${union?.reason ?? "未探测"}`,
				};
			}

			const violations = [];
			// `dispose` 是本工单的核心断言。它既不在 cordis 核心，也不在整棵树的并集里。
			if (
				union.events.includes("dispose") ||
				core.events?.includes("dispose")
			) {
				violations.push({
					where: `${core.eventsPath ?? "harness Events 接口"}`,
					detail:
						"harness 侧 Events 接口里出现了 `dispose`，本守卫的前提（dispose 不是事件）已失效，需重新核对。",
				});
			}

			// 核心的 9 个事件必须被并集覆盖；否则说明并集漏扫了 cordis 核心。
			const missingCore = (core.events ?? []).filter(
				(name) => !union.events.includes(name),
			);
			if (missingCore.length > 0) {
				violations.push({
					where:
						union.sources.map((s) => s.file).join(", ") ||
						"harness 安装树的 .d.ts 扫描",
					detail: `并集漏掉了 cordis 核心事件：${missingCore.join(", ")}。事件并集的扫描范围可能不完整。`,
				});
			}

			const expected = new Set(union.events);
			for (const file of findRepoFiles(defaultRepoRoot, (p) =>
				/\.(?:ts|tsx|js|mjs|cjs)$/.test(p),
			)) {
				// 守卫自身与构建产物不参与：前者在 expected 文案里举例说明事件写法，
				// 后者是 `graded/lib/` 下由 `graded/src/` 生成的降级产物，改一处即可。
				if (file.startsWith("guard/") || file.startsWith("graded/lib/"))
					continue;
				const text = readRepoFile(file);
				if (text === undefined) continue;
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i += 1) {
					const line = lines[i];
					// 注释里举例说明事件写法不算违规。
					const trimmed = line.trim();
					if (
						trimmed.startsWith("//") ||
						trimmed.startsWith("*") ||
						trimmed.startsWith("/*")
					)
						continue;
					for (const match of line.matchAll(/ctx\.on\(\s*['"]([^'"]+)['"]/g)) {
						const name = match[1];
						if (expected.has(name)) continue;
						violations.push({
							where: `${file}:${i + 1}`,
							detail: `监听的事件名 \`${name}\` 不在 harness 的 Events 接口并集中。该行：${trimmed}`,
							// graded 的生命周期清理归工单 11（修 graded 生命周期与请求校验）。
							owner: file.startsWith("graded/") ? "11" : null,
						});
					}
				}
			}
			return { ok: violations.length === 0, violations };
		},
	},

	{
		id: "dsh-tools-register-parameters",
		contract:
			"dsh-tools 的 register() 路径不校验 definition.parameters，只对 output.schema 调 assertSupportedJsonSchema",
		expected:
			"通过 `ctx.get('tools').register(defineTool({...}))` 注册工具时，`parameters` 必须是 `defineTool()` 能编译的 DSL（`parameterSchemaSpecToJsonSchema`）；不能指望 register() 替你校验 parameters，也不要绕过 defineTool 直接塞 JSON Schema 到 parameters。",
		severity: "blocking",
		check(probe) {
			const info = probe.dshToolsRegister;
			if (!info.available)
				return { ok: true, skip: `dsh-tools 不可探测：${info.reason}` };

			const violations = [];
			if (!info.registerValidatesOutputSchema) {
				violations.push({
					where: info.indexPath,
					detail:
						"register() 不再对 output.schema 调用 assertSupportedJsonSchema —— 契约形状变了，需重新核对。",
				});
			}
			if (info.registerValidatesParameters) {
				violations.push({
					where: info.indexPath,
					detail:
						"register() 现在会校验 parameters —— 本守卫记录的“不校验”前提失效，需重新核对。",
				});
			}
			if (!info.defineToolCompilesParameters) {
				violations.push({
					where: info.indexPath,
					detail:
						"defineTool() 不再调用 parameterSchemaSpecToJsonSchema(options.parameters) —— parameters 的编译路径变了。",
				});
			}
			return { ok: violations.length === 0, violations };
		},
	},

	{
		id: "client-modules-public-surface",
		contract:
			"clientModules（ClientModuleRegistry）的公开方法面：`rebuilt` 公开；`reconcilePackage` / `processOne` / `table` 等为 private，不是公开删行手段",
		expected:
			"只用公开方法：`graph()`、`clientPath(id)`、`fetchBundle(request)`、`artifactBaseline(id)`、`rebuilt(id)`、`onRebuilt(fn)`、`onGraphChanged(fn)`。删客户端模块行只能走公开途径，不要直改 private `table`，也不要调用 private 的 `reconcilePackage`/`processOne` 当公开 API。",
		severity: "blocking",
		check(probe) {
			const cm = probe.clientModules;
			if (!cm.available)
				return { ok: true, skip: `dsh-client-modules 不可探测：${cm.reason}` };

			const violations = [];
			const requirePublic = [
				"graph",
				"clientPath",
				"fetchBundle",
				"artifactBaseline",
				"rebuilt",
				"onRebuilt",
				"onGraphChanged",
			];
			for (const name of requirePublic) {
				if (!cm.publicMethods.includes(name)) {
					violations.push({
						where: cm.typesPath,
						detail: `公开方法 \`${name}\` 已从 ClientModuleRegistry 的公开面消失。当前公开面：${cm.publicMethods.join(", ")}`,
					});
				}
			}

			// 工单原文要求「断言包含 reconcilePackage」，但实测它是 private。这里按实测断言：
			// reconcilePackage 必须在 private 面，否则说明它被提升为公开 API，仓库用法需要重新评估。
			if (!cm.privateMembers.includes("reconcilePackage")) {
				violations.push({
					where: cm.typesPath,
					detail:
						"`reconcilePackage` 已不在 private 面（可能被提升为公开 API）—— 守卫记录的前提失效，需重新核对。",
				});
			}
			if (!cm.privateMembers.includes("table")) {
				violations.push({
					where: cm.typesPath,
					detail:
						"`table` 已不在 private 面 —— 「table 不是公开删行手段」的前提失效，需重新核对。",
				});
			}

			// 仓库侧：不得访问 private 成员。
			//
			// 判据刻意**不绑定变量名**：早先只匹配 `\bcm\.<member>`，于是任何换个变量名
			// 的调用点（`cmSvc.processOne`、`clientModules.pkgMeta`）都会漏报 —— 实测
			// 漏掉了 `injector/src/index.ts` 的两处 `processOne` 单参调用。现在改为
			// 「任意接收者 + 任意私有成员名」，并在行内排掉注释行。
			const privateAccess = [...new Set([...cm.privateMembers, "pkgMeta"])];
			// 成员名都是合法标识符，直接拼进正则即可 —— 不引 probe 内部的 escapeRegExp
			// （它没有导出，用了就是 ReferenceError，而守卫会把抛错报成「(guard 内部)」违规）。
			// 尾部的 `(?!s)` 不可省：私有面里既有单数 `source`，仓库里也就有大量复数
			// `sources`。没有它，`events.sources`、`union.sources` 这类普通字段名会被
			// 当成 private 成员访问 —— 判据一放宽就立刻自伤（实测 guard/ 自身报 3 条）。
			const accessPattern = new RegExp(
				`(?:^|[^\\w.])[A-Za-z_$][\\w$]*\\s*\\.\\s*(${privateAccess.join("|")})(?!s)\\b`,
				"g",
			);
			for (const file of findRepoFiles(defaultRepoRoot, (p) =>
				/\.(?:ts|tsx|js|mjs|cjs)$/.test(p),
			)) {
				// 守卫自身不参与：它的注释与变量名里必然出现这些成员名（本段就在解释为什么
				// 不能碰它们），扫自己只会制造假阳性。与 cordis-event-names 守卫同一豁免。
				if (file.startsWith("guard/")) continue;
				const text = readRepoFile(file);
				if (text === undefined) continue;
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i += 1) {
					const line = lines[i];
					// 注释行不算访问：本仓库大量注释在解释"为什么不能碰 table/processOne"。
					const trimmed = line.trim();
					if (
						trimmed.startsWith("//") ||
						trimmed.startsWith("*") ||
						trimmed.startsWith("/*")
					)
						continue;
					accessPattern.lastIndex = 0;
					const hit = accessPattern.exec(line);
					if (hit === null) continue;
					violations.push({
						where: `${file}:${i + 1}`,
						detail: `访问了 ClientModuleRegistry 的 private 成员 \`${hit[1]}\`。该行：${trimmed}`,
						// 消除私有成员绕过归工单 03（修注入器客户端模块联动）。
						owner: file.startsWith("injector/") ? "03" : null,
					});
				}
			}
			return { ok: violations.length === 0, violations };
		},
	},

	{
		id: "installable-package-names",
		contract:
			"仓库中出现的每个 @deepseek-ai/* specifier 都必须是 harness 里**真实存在**的包",
		expected:
			"`@deepseek-ai/<name>` 要么出现在 harness 的 packages.md 可安装插件清单里，要么真实存在于 harness 安装树的 node_modules 下（内部实现包、第三方传递依赖）。**编造**的包名一律报违规。只扫**可被解析的 specifier 位置**（源码 import、package.json 依赖、cordis 补丁里的插件名、安装脚本）；`.md` 是散文，没有 specifier 位置，不在扫描范围内。",
		severity: "blocking",
		check(probe) {
			const harness = probe.harness;
			// 两个判据都不完整，必须都不可用才算「测不了」：
			// 清单只覆盖可安装插件包，安装树才覆盖内部实现包与传递依赖。
			const installed = new Set(harness.installedPackages ?? []);
			if (!harness.packagesMdAvailable && installed.size === 0) {
				return {
					ok: true,
					skip: `既读不到可安装包清单（${harness.packagesMdPath}），也扫不到安装树；无法判定包名是否存在`,
				};
			}
			const installable = new Set(harness.installablePackages ?? []);

			const violations = [];
			const seen = new Set();
			for (const hit of probe.repoSources.specifiers) {
				const bare = stripSubpath(hit.specifier);
				// specifier 里的尾部 `-` 或 `*` 是文档里的通配写法（`@deepseek-ai/dsh-*`），
				// 不是真的包名，跳过。
				if (/[-*]$/.test(bare)) continue;
				// 判据一：在可安装插件清单里。
				if (installable.has(bare)) continue;
				// 判据二：在 harness 安装树里真实存在。
				//
				// 这一条是**语义**判据，取代早先手写的基建包白名单。手写名单追不上 harness
				// 的包增长：每新增一个内部实现包（`dsh-util-values`、`dsh-ptc-runtime`…）
				// 就要改一次守卫，而漏改的表现是**守卫自己制造假阳性** —— 把真实存在的
				// harness 内部包报成「不在清单内」。清单回答的是「能不能装」，不是「存不存在」；
				// 只有后者才是这条守卫要拦的错。
				if (installed.has(bare)) continue;
				const key = `${bare}|${hit.file}`;
				if (seen.has(key)) continue;
				seen.add(key);
				violations.push({
					where: `${hit.file}:${hit.line}`,
					detail: `specifier \`${bare}\` 既不在可安装包清单内，也不存在于 harness 安装树 —— 该包名不存在。该行：${hit.text}`,
					owner: ownerForSpecifier(bare, hit.file),
				});
			}
			return { ok: violations.length === 0, violations };
		},
	},

	{
		id: "harness-version-alignment",
		contract: `仓库声明的 DSH 版本（peerDependencies 里的 @deepseek-ai/dsh）与本机安装的 harness 版本必须一致（基线 ${BASELINE_HARNESS_VERSION}）`,
		expected: `仓库依赖声明与已安装 harness 都应为 ${BASELINE_HARNESS_VERSION}。版本不一致时需同步声明或升级安装，不得静默漂移。`,
		severity: "blocking",
		check(probe) {
			const installed = probe.harness.version;
			if (!installed) return { ok: true, skip: "未读到 harness 安装版本" };

			const declared = collectDeclaredDshVersions();
			const violations = [];
			for (const { file, value } of declared) {
				if (value === installed) continue;
				violations.push({
					where: file,
					detail: `仓库声明的 DSH 版本为 \`${value}\`，本机安装的 harness 版本为 \`${installed}\`，两者不一致。`,
				});
			}
			if (installed !== BASELINE_HARNESS_VERSION) {
				violations.push({
					where: `本机 harness 安装（${probe.harness.root}）`,
					detail: `安装版本 \`${installed}\` 与基线 \`${BASELINE_HARNESS_VERSION}\` 不一致。若确为有意升级，请同步更新 guard/contracts.mjs 里的 BASELINE_HARNESS_VERSION 与快照。`,
				});
			}
			return { ok: violations.length === 0, violations };
		},
	},

	{
		id: "package-metadata-paths",
		contract:
			"包元数据（package.json）里的每个路径引用都必须**真实存在**，不得悬空",
		expected:
			"`main`/`module`/`types`/`typings`/`bin`/`exports`/`files` 里写的路径必须能在该包目录下解析到真实文件或目录。若某个产物根本不生成（例如构建只复制文件、不产出 `.d.ts`），就**删掉**对应字段，而不是留一个指向空处的引用 —— 悬空引用会让消费者（TypeScript、打包器、CLI）在运行时才失败。",
		severity: "blocking",
		check(probe) {
			// 本守卫刻意**不依赖 harness**：它审的是本仓库自己的元数据自洽性。
			// 因此没有「跳过」分支 —— 缺 harness 不该让这条契约消失。
			const entries = probe.packageMetadata?.entries;
			if (entries === undefined) {
				return {
					ok: false,
					violations: [
						{
							where: "guard/lib/probe.mjs",
							detail:
								"probe.packageMetadata 缺失：探测实现未挂进 probeAll，本守卫的前提失效。",
						},
					],
				};
			}

			const violations = [];
			for (const entry of entries) {
				if (entry.exists) continue;
				// `where` 保持纯粹的 `file:line` 定位符（与其余守卫一致，编辑器里可点）。
				// 定位不到行号时给 `file`，再由 detail 说清是哪个字段 —— 不把字段名塞进
				// `where`，否则它就不再是「能跳转的位置」了。
				const at =
					entry.line === undefined ? entry.file : `${entry.file}:${entry.line}`;
				violations.push({
					where: at,
					detail: `元数据字段 \`${entry.field}\` 声明的路径 \`${entry.target}\` 解析后不存在 —— 悬空引用。若该产物不由构建生成，请删除该字段；若应当生成，请让构建真的产出它。`,
					owner: ownerForMetadataPath(entry.file),
				});
			}
			return { ok: violations.length === 0, violations };
		},
	},
];

/**
 * 剥掉 specifier 的子路径。
 *
 * `@scope/name/sub/path` → `@scope/name`；不含子路径时原样返回。
 * （此处刻意不写出真实字面量：守卫会用正则扫自己的源码找 `@deepseek-ai/*`，
 * 示例里写真实包名会被自己扫成「不存在的包」。）
 *
 * @param {string} specifier 完整 specifier。
 * @returns {string} 去掉子路径后的包名。
 */
function stripSubpath(specifier) {
	const scopeEnd = specifier.indexOf("/");
	if (scopeEnd === -1) return specifier;
	const pathEnd = specifier.indexOf("/", scopeEnd + 1);
	return pathEnd === -1 ? specifier : specifier.slice(0, pathEnd);
}

/**
 * 判断某个「不存在 / 不在清单内」的 specifier 该由哪张工单负责修。
 *
 * 归属来自工单 02–12 对同一处缺陷的认领（各工单的验收标准里都点了名）。
 * 返回 `null` 表示没有任何工单认领 —— 这种违规一律阻断，因为它是新引入的。
 *
 * @param {string} bare 去掉子路径的包名。
 * @param {string} file 仓库相对路径。
 * @returns {string | null} 工单号，或 null。
 */
function ownerForSpecifier(bare, file) {
	// 注入器换了客户端模块包名：工单 02 修注入器清单与 cordis peer 声明。
	if (bare === "@deepseek-ai/dsh-client-runtime") return "02";
	// 预设里的 workflow worker-thread 已被 ptc 取代：
	// 06 负责 router-standard，07 负责 router-react 与 router-spec。
	if (bare === "@deepseek-ai/dsh-workflow-worker-thread") {
		if (file.includes("router-standard")) return "06";
		if (file.includes("router-react") || file.includes("router-spec"))
			return "07";
		return null;
	}
	return null;
}

/**
 * 判断某个悬空的元数据路径该由哪张工单负责修。
 *
 * 与 `ownerForSpecifier` 同一套思路：已被其它工单认领的缺陷只报告不阻断，无归属的
 * （新引入的）一律阻断。
 *
 * 注意两类 `types` 缺陷的正确修法**相反**，不要混为一谈：
 * - `graded/`：构建只复制文件、根本不产出声明文件 → 正确修法是**删掉**字段。
 *   本工单（09）已修。
 * - `injector/`：配了 tsdown 且声明了 types → 正确修法是让构建**真的产出**
 *   `lib/types/`，归工单 03。
 *
 * @param {string} file 仓库相对路径。
 * @returns {string | null} 工单号，或 null。
 */
function ownerForMetadataPath(file) {
	// 注入器的类型入口悬空：工单 03（修注入器清单与 cordis peer 声明）。
	if (file.startsWith("injector/")) return "03";
	// preset 的 bundle 迁移还没把运行时脚本搬进 bundle 目录：06 管 router-standard，
	// 07 管 router-react 与 router-spec。（bundle/package.json 的 exports 指的
	// `./router-bootstrap-v34.mjs` 等文件此刻还在上一级目录。）
	if (file.startsWith("preset/router-standard")) return "06";
	if (
		file.startsWith("preset/router-react") ||
		file.startsWith("preset/router-spec")
	)
		return "07";
	return null;
}

/**
 * 收集仓库里声明的 DSH 版本。
 *
 * 只认显式依赖 `@deepseek-ai/dsh`（各 package.json 的 dependencies / devDependencies /
 * peerDependencies）。裸 `cordis` / `schemastery` 这类别名写法不在本守卫范围。
 *
 * @returns {Array<{file: string, value: string}>}
 */
function collectDeclaredDshVersions() {
	/** @type {Array<{file: string, value: string}>} */
	const found = [];
	for (const file of findRepoFiles(defaultRepoRoot, (p) =>
		p.endsWith("package.json"),
	)) {
		const json = readRepoJson(file);
		if (!json) continue;
		for (const field of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
		]) {
			const value = json[field]?.["@deepseek-ai/dsh"];
			if (typeof value === "string")
				found.push({ file: `${file} (${field})`, value });
		}
	}
	return found;
}

/**
 * 跑所有守卫。
 *
 * @param {object} [options]
 * @param {string} [options.harnessRoot]
 * @returns {{ probe: object, results: Array<object>, failed: number, reported: number, skipped: number, unavailable: boolean }}
 */
export function runGuards(options = {}) {
	const probe = probeAll(options);
	if (!probe.harness.available) {
		return {
			probe,
			results: [],
			failed: 0,
			reported: 0,
			skipped: 0,
			unavailable: true,
		};
	}

	const results = guards.map((guard) => {
		let outcome;
		try {
			outcome = guard.check(probe);
		} catch (error) {
			outcome = {
				ok: false,
				violations: [
					{
						where: "(guard 内部)",
						detail: `守卫执行抛错：${error?.message ?? error}`,
					},
				],
			};
		}

		// 逐条违规决定 severity：工单未落地 → report-only；工单已落地（或违规无归属）→ blocking。
		const violations = (outcome.violations ?? []).map((v) => {
			const owner = v.owner ?? null;
			const pending = owner !== null && !DONE_TICKETS.has(owner);
			return { ...v, owner, pending };
		});
		const blockingViolations = violations.filter((v) => !v.pending);
		const pendingViolations = violations.filter((v) => v.pending);

		// 守卫整体的 severity 反映「最严重的那一档」；实际阻断判定按违规逐条算。
		const severity =
			guard.severity === "report-only" ||
			(violations.length > 0 && blockingViolations.length === 0)
				? "report-only"
				: "blocking";

		return {
			id: guard.id,
			contract: guard.contract,
			expected: guard.expected,
			severity,
			ok: outcome.ok,
			skip: outcome.skip,
			violations,
			blockingViolations,
			pendingViolations,
		};
	});

	const blockingFailed = results.filter((r) => r.blockingViolations.length > 0);
	const reportOnlyFailed = results.filter(
		(r) => r.blockingViolations.length === 0 && r.pendingViolations.length > 0,
	);
	return {
		probe,
		results,
		failed: blockingFailed.length,
		reported: reportOnlyFailed.length,
		skipped: results.filter((r) => r.skip).length,
		unavailable: false,
	};
}

/**
 * 渲染人类可读报告。
 *
 * @param {ReturnType<typeof runGuards>} outcome
 * @param {{ harnessRoot?: string }} [meta]
 * @returns {string}
 */
export function formatReport(outcome, meta = {}) {
	const lines = [];
	lines.push("契约守卫 — DSH 接口契约基线条");
	lines.push("=".repeat(72));

	if (outcome.unavailable) {
		lines.push(`⚠ 探测不可用：${outcome.probe.harness.reason}`);
		lines.push(
			"  本机没有可读的 harness 安装，本次**未做任何断言**（既不算通过，也不算违规）。",
		);
		lines.push("  这是明确跳过，不是误报通过。");
		return lines.join("\n");
	}

	const { probe } = outcome;
	if (meta.harnessRoot) lines.push(`harness 安装：${meta.harnessRoot}`);
	lines.push(`harness 版本：${probe.harness.version}`);
	lines.push(`可安装包清单：${probe.harness.packagesMdPath}`);
	lines.push(
		`  条目数：${probe.harness.installablePackageCount}  sha256：${probe.harness.packagesMdSha256}`,
	);
	lines.push(`仓库 specifier 命中：${probe.repoSources.specifiers.length} 处`);
	lines.push("");

	for (const result of outcome.results) {
		const tag = result.ok
			? "PASS"
			: result.blockingViolations.length > 0
				? "FAIL"
				: "WARN";
		lines.push(`[${tag}] ${result.id}  (${result.severity})`);
		if (result.skip) {
			lines.push(`      ⊘ 跳过：${result.skip}`);
		}
		if (!result.ok) {
			lines.push(`      违反的契约：${result.contract}`);
			lines.push(`      期望写法：${result.expected}`);
			for (const v of result.violations) {
				// 归属到尚未落地的工单 → 只报告不阻断（避免在修复完成前让整条流水线红掉）。
				const note = v.pending ? `  (待工单 ${v.owner} 修复，暂不阻断)` : "";
				lines.push(`      ✗ 违反位置：${v.where}${note}`);
				lines.push(`        ${v.detail}`);
			}
		}
		lines.push("");
	}

	lines.push("-".repeat(72));
	lines.push(
		`阻断失败 ${outcome.failed} 条，只报告不阻断 ${outcome.reported} 条，跳过 ${outcome.skipped} 条，共 ${outcome.results.length} 条守卫。`,
	);
	const pendingOwners = [
		...new Set(
			outcome.results
				.flatMap((r) => r.pendingViolations.map((v) => v.owner))
				.filter((o) => o !== null),
		),
	].sort();
	if (outcome.reported > 0) {
		lines.push(
			`只报告不阻断的条目由工单 ${pendingOwners.join("、")} 负责修复；对应工单落地后（登记进 guard/tickets.json 的 done）守卫会自动转为阻断，不需改守卫代码。`,
		);
	}
	return lines.join("\n");
}

/** 命令行入口。 */
function main() {
	const argv = process.argv.slice(2);
	const json = argv.includes("--json");
	const rootIndex = argv.indexOf("--harness-root");
	const harnessRoot = rootIndex === -1 ? undefined : argv[rootIndex + 1];

	const outcome = runGuards({ harnessRoot });
	const harnessRootUsed = outcome.probe.harness.root;

	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					harness: { root: harnessRootUsed, ...outcome.probe.harness },
					failed: outcome.failed,
					reported: outcome.reported,
					skipped: outcome.skipped,
					unavailable: outcome.unavailable,
					results: outcome.results,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		process.stdout.write(
			`${formatReport(outcome, { harnessRoot: harnessRootUsed })}\n`,
		);
	}

	if (outcome.unavailable) process.exitCode = 2;
	else if (outcome.failed > 0) process.exitCode = 1;
	else process.exitCode = 0;
}

main();
