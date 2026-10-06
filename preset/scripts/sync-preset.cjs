#!/usr/bin/env node
/**
 * sync-preset.cjs — bundle 时代的预设快照同步器（工单 08 重写）
 *
 * ── 为什么重写 ──────────────────────────────────────────────────────
 * 旧版四根支柱全断（全部实测）：
 *   1. 源码根拼错一层：`path.join(REQ, 'preset')` 得到 `preset/preset`，
 *      而本仓预设直接位于 `preset/router-<id>/` —— 该目录不存在。
 *   2. 回退主目录硬编码 `C:\Users\Eldwen`（本机不存在）；且
 *      `path.join(DSH_HOME, '.dsh', ...)` 在 DSH_HOME 已含 `.dsh` 时双重拼接。
 *   3. 投放目标是 `$DSH_HOME/.agent-presets/<id>/` —— 该目录协议已废弃。
 *      实测在整个已安装 harness 的 `@deepseek-ai/*` 里搜 `agent-presets`
 *      只有 5 处命中，全是插件名 / UI 分组 id，**没有任何代码读那个目录**。
 *      现在预设靠 **bundle 包**生效：`preset/router-<id>/bundle/` 带
 *      `package.json`（`dsh.bundle.patch` 指向 `cordis.patch.yml`）+ 声明行。
 *   4. 硬编码运行目录版本号 `router-standard-v22`，而真实文件名是 `-v34`。
 *
 * ── 生成规则（唯一权威，勿在别处另写一套）─────────────────────────────
 *   编辑基准 = 无版本号别名：`router-<id>/router-bootstrap.mjs`、`router-core.mjs`
 *   快照     = 带版本号：    `router-bootstrap-vNN.mjs`、`router-core-vNN.mjs`
 *
 *     router-core-vNN.mjs      := router-core.mjs 的逐字节副本
 *     router-bootstrap-vNN.mjs := router-bootstrap.mjs，其中对 core 的
 *                                 相对引用被改写为 `./router-core-vNN.mjs`
 *                                 （别名里写 `./router-core.mjs` 或已写版本化
 *                                  名字都接受，输出恒为版本化名字 → 对已有漂移自愈）
 *
 *   落点：`router-<id>/`（供 selftest 与 preset/router.test.mjs 读）
 *         **和** `router-<id>/bundle/`（loader 实际读的那份）。
 *   版本号来源：`router-<id>/bundle/cordis.patch.yml` 里
 *         `router-bootstrap-v(\d+)\.mjs` 的引用 —— 因为那才是 loader 读的文件。
 *
 * ── 缓存破坏（?v=N）——bundle 协议下**已不需要** ──────────────────────
 *   历史：旧版用相对行 `name: ./router-bootstrap-vNN.mjs?v=88` 绕 ESM 的 URL
 *   缓存。该写法在 bundle 协议下**无法工作**：预设的运行时行嵌在
 *   `config.plugins[]` 里，而 `anchorInsertedPluginNames`（dsh-app-boot）只
 *   重写它经 `entry.group && Array.isArray(entry.config)` 能走到的 `name`
 *   字段 —— 相对行永不被锚定，loader 便按 **profile 目录**解析，报
 *   `ERR_MODULE_NOT_FOUND`（实测：三个预设全部因此加载失败）。
 *   现在改为**裸包名**：`@dsh-external/dsh-preset-router-<id>/router-bootstrap-vNN.mjs`，
 *   经 `bundle/package.json` 的 `exports` 映射解析 —— 这也是官方每个预设补丁
 *   的做法。
 *   裸包名子路径**不能**带查询串：`exports` 是精确匹配，`?v=88` 直接报
 *   `ERR_PACKAGE_PATH_NOT_EXPORTED`。而缓存破坏本身也不需要了：bundle patch
 *   只在 DSH **启动时**读取，重启既重读补丁、也丢弃 ESM 缓存。
 *   `--bump` 因此退化为「确认没有残留的 `?v=`」。
 *
 * 用法：
 *   node scripts/sync-preset.cjs <router-standard|router-react|router-spec> [--bump] [--check]
 *   node scripts/sync-preset.cjs --all [--bump] [--check]
 *   node scripts/sync-preset.cjs --check-profile <profile 的 cordis.patch.yml 路径>
 *
 * 退出码：0 = 一致；1 = 发现不一致 / 生成失败。
 * 幂等：内容相同则不写盘（只报「无变化」），连续跑两次第二次全为「无变化」。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// preset/ 仓库根（本文件位于 preset/scripts/）
const PRESET_ROOT = path.resolve(__dirname, "..");
const PRESETS = ["router-standard", "router-react", "router-spec"];

// ── 生成规则的唯一实现 ──────────────────────────────────────────────
const CORE_REF_RE = /(from\s+['"])\.\/router-core(?:-v\d+)?\.mjs(['"])/;
const CORE_REF_VERSIONED_RE = /from\s+['"]\.\/router-core-v\d+\.mjs['"]/;
// 仅用于**检出**残留的 `?v=`（bundle 协议下不该再有）。带 `#` 前缀的行是注释。
const CACHE_BUSTER_RE = /(\.mjs)(\?v=)(\d+)/g;
// 工单 08 第 7 条：profile 里"指向路由预设"的 id 形态
const ROUTER_PRESET_ID_RE =
	/^(dsh-router|preset-router|router-(standard|react|spec))/;

const problems = [];
const warnings = [];

function log(msg) {
	console.log(msg);
}
function warn(msg) {
	warnings.push(msg);
	console.log("  ! " + msg);
}
function problem(msg) {
	problems.push(msg);
	console.log("  x " + msg);
}
function die(msg) {
	console.error("[sync-preset] " + msg);
	process.exit(1);
}
function rel(p) {
	return path.relative(PRESET_ROOT, p) || ".";
}

function presetDirOf(name) {
	if (!PRESETS.includes(name))
		die(`未知预设: ${name}（可选 ${PRESETS.join(" | ")}）`);
	const dir = path.join(PRESET_ROOT, name);
	if (!fs.existsSync(dir)) die(`预设目录不存在: ${dir}`);
	return dir;
}

/**
 * 版本号的唯一来源 = bundle patch 里对 bootstrap 快照的引用。
 * 理由：loader 真正读的是 `bundle/cordis.patch.yml`，它指向哪个版本，
 * 快照就必须是哪个版本。不从文件名反推、不从 `agent.cordis.yml` 读
 * （后者是已废弃目录协议的遗留，只被 selftest 引用）。
 */
function versionOf(dir) {
	const patch = path.join(dir, "bundle", "cordis.patch.yml");
	if (!fs.existsSync(patch)) die(`bundle patch 不存在: ${patch}`);
	const m = fs
		.readFileSync(patch, "utf8")
		.match(/router-bootstrap-v(\d+)\.mjs/);
	if (!m) die(`bundle patch 里找不到 router-bootstrap-vNN.mjs 引用: ${patch}`);
	return m[1];
}

/** 按生成规则渲染 bootstrap 快照。返回 null 表示别名结构不合规（已记 problem）。 */
function renderBootstrap(aliasSrc, ver, label) {
	const hits = aliasSrc.match(new RegExp(CORE_REF_RE.source, "g")) || [];
	if (hits.length !== 1) {
		problem(
			`${label}: 别名 bootstrap 里对 core 的相对引用应恰好 1 处，实测 ${hits.length} 处`,
		);
		return null;
	}
	if (CORE_REF_VERSIONED_RE.test(aliasSrc)) {
		warn(
			`${label}: 别名 bootstrap 用了版本化 core 引用（${hits[0]}）—— 别名应保持无版本号；本次仍照常生成正确快照`,
		);
	}
	return aliasSrc.replace(CORE_REF_RE, `$1./router-core-v${ver}.mjs$2`);
}

/** 内容相同就不写盘 —— 这是幂等的实现方式。 */
function writeIfChanged(file, content, label) {
	const abs = path.resolve(file);
	const exists = fs.existsSync(abs);
	if (exists && fs.readFileSync(abs, "utf8") === content) {
		log(`  = ${label}：无变化`);
		return false;
	}
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	log(`  ${exists ? "~" : "+"} ${label}：已写入（${content.length} B）`);
	return true;
}

function checkNoCacheBusters(dir) {
	// 只检查 loader 真正读的那份。agent.cordis.yml 是已废弃协议的遗留
	// （仅 selftest 引用），里面的 ?v= 无害，故不在此列。
	const f = path.join(dir, "bundle", "cordis.patch.yml");
	if (!fs.existsSync(f)) return;
	for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
		if (/^\s*#/.test(line)) continue;
		if (CACHE_BUSTER_RE.test(line)) {
			problem(
				`${rel(f)}：仍有 ?v= 查询串 —— 裸包名子路径带查询会报 ERR_PACKAGE_PATH_NOT_EXPORTED。该行：${line.trim()}`,
			);
			CACHE_BUSTER_RE.lastIndex = 0;
		}
	}
}

/** 生成后逐对校验（工单 08 第 5 条：生成后逐对校验一致）。 */
function verify(dir, ver) {
	const aliasCore = fs.readFileSync(path.join(dir, "router-core.mjs"), "utf8");
	const aliasBoot = fs.readFileSync(
		path.join(dir, "router-bootstrap.mjs"),
		"utf8",
	);
	const wantBoot = renderBootstrap(aliasBoot, ver, path.basename(dir));

	const pairs = [
		[
			path.join(dir, `router-core-v${ver}.mjs`),
			aliasCore,
			`router-core-v${ver}.mjs == 别名`,
		],
		[
			path.join(dir, "bundle", `router-core-v${ver}.mjs`),
			aliasCore,
			`bundle/router-core-v${ver}.mjs == 别名`,
		],
	];
	if (wantBoot !== null) {
		pairs.push(
			[
				path.join(dir, `router-bootstrap-v${ver}.mjs`),
				wantBoot,
				`router-bootstrap-v${ver}.mjs == 按规则生成`,
			],
			[
				path.join(dir, "bundle", `router-bootstrap-v${ver}.mjs`),
				wantBoot,
				`bundle/router-bootstrap-v${ver}.mjs == 按规则生成`,
			],
		);
	}
	for (const [f, want, label] of pairs) {
		if (!fs.existsSync(f)) {
			problem(`${label}：文件缺失 ${rel(f)}`);
			continue;
		}
		const got = fs.readFileSync(f, "utf8");
		if (got !== want)
			problem(
				`${label}：内容不一致（${rel(f)} ${got.length} B != ${want.length} B）`,
			);
	}

	// bundle patch 必须引用本次生成的版本
	const patch = fs.readFileSync(
		path.join(dir, "bundle", "cordis.patch.yml"),
		"utf8",
	);
	if (!patch.includes(`router-bootstrap-v${ver}.mjs`))
		problem(`bundle patch 未引用 router-bootstrap-v${ver}.mjs`);

	// 运行时行必须是**裸包名子路径**，且该子路径已在 bundle/package.json 的
	// exports 里声明 —— 否则 loader 解析时报 ERR_PACKAGE_PATH_NOT_EXPORTED。
	// 相对行 `./x.mjs` 在本位置永远解析失败（见头部「缓存破坏」段），故直接报错。
	const pkgPath = path.join(dir, "bundle", "package.json");
	if (!fs.existsSync(pkgPath)) {
		problem("bundle/package.json 缺失，无法校验模块行的 exports 声明");
	} else {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		const exported = new Set(Object.keys(pkg.exports ?? {}));
		const selfName = pkg.name;
		for (const m of patch.matchAll(/name:\s*['"]?(\.\/[^'"\s]+)['"]?/g)) {
			problem(
				`bundle patch 仍用相对模块行 ${m[1]} —— 它嵌在 config.plugins[] 里，永不被锚定，会按 profile 目录解析而失败；请改用裸包名`,
			);
		}
		for (const m of patch.matchAll(
			/name:\s*['"](@[^'"\s]+?\/[^'"\s]+?)['"]/g,
		)) {
			const spec = m[1];
			if (selfName !== undefined && spec.startsWith(`${selfName}/`)) {
				const subpath = `./${spec.slice(selfName.length + 1)}`;
				if (!exported.has(subpath))
					problem(
						`bundle patch 引用了 ${spec}，但 package.json 的 exports 未声明 ${subpath}`,
					);
			}
		}
	}
}

function syncPreset(name, opts) {
	const dir = presetDirOf(name);
	const ver = versionOf(dir);
	log(`\n== ${name}（版本 v${ver}）==`);

	// --bump 在 bundle 协议下已无对象可递增：改为检查残留的 ?v=。
	checkNoCacheBusters(dir);

	const aliasBoot = fs.readFileSync(
		path.join(dir, "router-bootstrap.mjs"),
		"utf8",
	);
	const aliasCore = fs.readFileSync(path.join(dir, "router-core.mjs"), "utf8");
	const snapBoot = renderBootstrap(aliasBoot, ver, name);

	if (!opts.checkOnly) {
		if (snapBoot !== null) {
			writeIfChanged(
				path.join(dir, `router-bootstrap-v${ver}.mjs`),
				snapBoot,
				`router-bootstrap-v${ver}.mjs`,
			);
			writeIfChanged(
				path.join(dir, "bundle", `router-bootstrap-v${ver}.mjs`),
				snapBoot,
				`bundle/router-bootstrap-v${ver}.mjs`,
			);
		}
		writeIfChanged(
			path.join(dir, `router-core-v${ver}.mjs`),
			aliasCore,
			`router-core-v${ver}.mjs`,
		);
		writeIfChanged(
			path.join(dir, "bundle", `router-core-v${ver}.mjs`),
			aliasCore,
			`bundle/router-core-v${ver}.mjs`,
		);

		// gitbash-executor 只有部分预设带；有就镜像进 bundle（bundle patch 引用它）
		const gb = path.join(dir, "gitbash-executor.mjs");
		if (fs.existsSync(gb)) {
			writeIfChanged(
				path.join(dir, "bundle", "gitbash-executor.mjs"),
				fs.readFileSync(gb, "utf8"),
				"bundle/gitbash-executor.mjs",
			);
		}
	}

	verify(dir, ver);
}

/**
 * 工单 08 第 7 条：profile 补丁里指向路由预设、却匹配不到任何声明行的配置项。
 * 这类悬空引用每次装载都产生警告。
 *
 * 只**报告**，不自动改写用户 profile —— profile 在仓库之外，静默改它有风险。
 * 修法二选一：把那一行删掉，或补上对应声明。
 *
 * 判定范围刻意收窄到"路由预设形态的 id"，避免把指向宿主插件的合法跨文件补丁
 * （如 `- id: dsh-super-injector`，其声明在另一份 patch 里）误报成悬空。
 */
function checkProfilePatch(patchPath) {
	if (!fs.existsSync(patchPath)) die(`profile patch 不存在: ${patchPath}`);
	const lines = fs.readFileSync(patchPath, "utf8").split(/\r?\n/);
	const declared = new Set();
	const patched = [];
	let insertIndent = null;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (/^\s*#/.test(raw) || raw.trim() === "") continue;
		const indent = raw.length - raw.trimStart().length;
		if (/^\s*insert:\s*$/.test(raw)) {
			insertIndent = indent;
			continue;
		}
		if (insertIndent !== null && indent <= insertIndent && !/^\s*-/.test(raw))
			insertIndent = null;
		const m = raw.match(/^\s*-?\s*id:\s*([A-Za-z0-9._@/-]+)\s*$/);
		if (!m) continue;
		if (insertIndent !== null) declared.add(m[1]);
		else patched.push({ id: m[1], line: i + 1 });
	}
	log(`\n== profile 悬空引用检查：${patchPath} ==`);
	log(`  声明行（insert 内）${declared.size} 个；补丁行 ${patched.length} 个`);
	const dangling = patched.filter(
		(p) => ROUTER_PRESET_ID_RE.test(p.id) && !declared.has(p.id),
	);
	if (dangling.length === 0) {
		log("  OK：没有指向路由预设的悬空引用");
	} else {
		for (const d of dangling)
			problem(
				`profile 第 ${d.line} 行：id '${d.id}' 匹配不到任何声明行（删掉该行，或补上对应声明）`,
			);
	}
}

function main() {
	const argv = process.argv.slice(2);
	const opts = {
		bump: argv.includes("--bump"),
		checkOnly: argv.includes("--check"),
		all: argv.includes("--all"),
	};

	const pi = argv.indexOf("--check-profile");
	if (pi >= 0) {
		const p = argv[pi + 1];
		if (!p) die("--check-profile 需要一个 patch 文件路径");
		checkProfilePatch(path.resolve(p));
		log("");
		log(
			`[sync-preset] ${problems.length === 0 ? "通过" : `发现 ${problems.length} 处悬空引用`}`,
		);
		process.exit(problems.length > 0 ? 1 : 0);
	}

	const names = argv.filter((a) => !a.startsWith("--"));
	let targets;
	if (opts.all) targets = PRESETS;
	else if (names.length === 1) targets = names;
	else
		die(
			"用法: node scripts/sync-preset.cjs <router-standard|router-react|router-spec>|--all [--bump] [--check]",
		);

	for (const n of targets) syncPreset(n, opts);

	log("");
	if (problems.length > 0) {
		log(`[sync-preset] 发现 ${problems.length} 处不一致：`);
		for (const p of problems) log("  - " + p);
	}
	if (warnings.length > 0) {
		log(`[sync-preset] ${warnings.length} 条提示：`);
		for (const w of warnings) log("  - " + w);
	}
	log(
		`[sync-preset] ${problems.length === 0 ? "全部一致" : "存在不一致"}（${targets.join(", ")}）`,
	);
	process.exit(problems.length > 0 ? 1 : 0);
}

main();
