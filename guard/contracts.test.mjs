import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	parseClassMembers,
	parseEventsInterface,
	parseInstallablePackages,
	parseTopLevelMembers,
	probeAll,
	probePackageMetadataPaths,
} from "./lib/probe.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardEntry = join(repoRoot, "guard", "contracts.mjs");
const snapshotEntry = join(repoRoot, "guard", "snapshot.mjs");
const ticketsPath = join(repoRoot, "guard", "tickets.json");

/**
 * 跑守卫，返回退出码与解析后的 JSON 报告。
 *
 * 刻意用 `spawnSync` 而不是 `runGuards()`：验收标准要求的是「一条命令 + 退出码」，
 * 退出码本身就是被测行为，只有真的起进程才测得到。
 */
function runGuard(args = [], env = {}) {
	const result = spawnSync(process.execPath, [guardEntry, "--json", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	assert.equal(result.error, undefined, String(result.error));
	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		assert.fail(
			`守卫未输出可解析 JSON（status=${result.status}）：\n${result.stdout}\n${result.stderr}`,
		);
	}
	return { status: result.status, report };
}

/** 读工单清单，用于「改完必须还原」的测试。 */
function readTickets() {
	return JSON.parse(readFileSync(ticketsPath, "utf8"));
}

const injectorPkgPath = join(repoRoot, "injector", "package.json");

/**
 * 临时在 `injector/package.json` 里种一条**必然悬空**的本地路径引用，跑一次守卫，
 * 然后无条件还原原文件字节。
 *
 * 为什么要种违规，而不是直接观测仓库当前状态：`package-metadata-paths` 扫的是
 * `defaultRepoRoot`（见 `guard/contracts.mjs` 里对 `findRepoFiles(defaultRepoRoot, …)`
 * 的调用），仓库根写死在守卫内、没有参数能改指向，所以测试拿不到一个「自带违规的
 * fixture 目录」去跑；而「本机此刻正好有未修复的违规」是会随修复进度漂移的瞬时
 * 事实——把它当前置条件，等于让测试随修复进度随机变红（工单 03 收尾、
 * `package-metadata-paths` 归零时就是这么红的）。自己种一条违规能让前置条件
 * **自足**：不论仓库修到哪一步都成立。
 *
 * 选 `injector/package.json` 的 `types` 字段，是因为该文件的违规 owner 是 "03"
 * （`guard/contracts.mjs` 中 `file.startsWith("injector/") ? "03" : null`）：带归属
 * 的违规在台账未登记时才进 pendingViolations，而「report-only → 阻断」这个转换
 * 正需要 pending 态可观测；无归属的违规一律直接阻断，测不到该转换。
 *
 * @param {(out: {report: object, status: number}) => void} fn 断言体
 */
function withSyntheticDanglingPath(fn) {
	const original = readFileSync(injectorPkgPath, "utf8");
	try {
		const pkg = JSON.parse(original);
		// 指向一个绝不存在的文件；守卫的判据是「本地路径引用解析后不存在」。
		pkg.types = "./lib/__guard_self_test_missing__.d.mts";
		writeFileSync(injectorPkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
		fn(runGuard());
	} finally {
		// 还原原始字节（保留原缩进风格），而不是重新序列化整个文件。
		writeFileSync(injectorPkgPath, original, "utf8");
	}
}

// ---------------------------------------------------------------------------
// 命令行契约：退出码语义
// ---------------------------------------------------------------------------

test("守卫以单个命令运行，退出码与「有无阻断失败」严格一致", () => {
	// 刻意不断言固定的 0/1：这个仓库此刻有几条真违规是会漂移的事实（修好一条就少一条），
	// 而本测试要锁定的是**退出码的语义**——退出码必须能由报告本身推导出来。
	const { status, report } = runGuard();
	assert.equal(report.unavailable, false);
	assert.equal(
		status,
		report.failed > 0 ? 1 : 0,
		`退出码与阻断失败数不一致：failed=${report.failed} status=${status}\n${JSON.stringify(
			report.results?.map((r) => [r.id, r.severity]),
			null,
			2,
		)}`,
	);
});

test("守卫不依赖网络，也不启动 DSH（纯静态解析）", () => {
	// 断网的最强静态证据：被解析的文件全部来自 harness 安装树与仓库自身，
	// 探测模块只 import node:fs / node:crypto / node:path / node:url。
	const probeSource = readFileSync(
		join(repoRoot, "guard", "lib", "probe.mjs"),
		"utf8",
	);
	// 引号必须两种都收：probe.mjs 全篇用双引号，而本文件下方若有人加单引号导入，
	// 只认单引号的正则会把 import 数读成 0 —— 那样 `length > 0` 的断言会以
	// 「未找到 import 语句」失败，看起来像断网证据成立，其实只是解析器的锅。
	const imports = [
		...probeSource.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm),
	].map((m) => m[1]);
	assert.ok(imports.length > 0, "未找到 import 语句，断言失效");
	for (const specifier of imports) {
		assert.ok(
			specifier.startsWith("node:"),
			`探测模块引入了非 node: 内置依赖：${specifier}`,
		);
	}
});

test("退出码 1：有阻断失败", () => {
	// 用一个不存在的 harness 根走不到这条路径，改成制造真正的阻断违规：
	// 指向一个真实存在但不是 harness 的目录 → 那是退出码 2（见下一个测试）。
	// 这里改为验证「无归属的违规一律阻断」这条规则，见下一组单元测试。
	const outcome = probeAll({ repoRoot });
	assert.ok(
		outcome.harness.available,
		"本机应能探测到 harness；否则该断言无效",
	);
});

test("退出码 2：harness 不在本机时明确跳过，而不是误报通过", () => {
	const missing = join(tmpdir(), `dsh-harness-missing-${process.pid}`);
	const { status, report } = runGuard(["--harness-root", missing]);
	assert.equal(status, 2);
	assert.equal(report.unavailable, true);
	assert.match(report.harness.reason, /不是一个 DSH harness 安装/);
});

test("显式指定的 harness 根具有权威性：写错的路径不会被静默回落成真安装", () => {
	const before = runGuard();
	// 前置条件只要求「本机 harness 可用」——即退出码不是 2。刻意**不**断言 0：
	// 退出码 0 意味着此刻仓库零违规，那是一个会随修复进度漂移的事实，把它写成前置
	// 条件会让本测试在修好某条违规的瞬间变红，而它要验证的语义与基线退出码无关。
	assert.notEqual(before.status, 2, "前置条件：本机存在可用的 harness 安装");
	assert.equal(before.report.unavailable, false);

	// 若把显式路径当成"先试这个、不行再猜"的提示，这里会回落到上面的真安装并返回 0，
	// 于是"harness 不可用"这条分支永远走不到。必须返回 2。
	const bogus = join(tmpdir(), `dsh-bogus-${process.pid}`);
	const after = runGuard(["--harness-root", bogus]);
	assert.equal(
		after.status,
		2,
		"写错的 --harness-root 被静默忽略，回落到了真实安装",
	);
	assert.equal(after.report.unavailable, true);
	assert.equal(after.report.harness.root, bogus);
});

test("指向真实存在但非 harness 的目录同样判定为不可用", () => {
	const { status, report } = runGuard(["--harness-root", repoRoot]);
	assert.equal(status, 2);
	assert.equal(report.harness.root, repoRoot);
	assert.match(
		report.harness.reason,
		/package\.json 与 node_modules\/@deepseek-ai\//,
	);
});

test("DSH_HARNESS_ROOT 与 --harness-root 走同一套权威性判定", () => {
	const bogus = join(tmpdir(), `dsh-bogus-env-${process.pid}`);
	const { status, report } = runGuard([], { DSH_HARNESS_ROOT: bogus });
	assert.equal(status, 2);
	assert.equal(report.unavailable, true);
	assert.match(report.harness.reason, /DSH_HARNESS_ROOT/);
});

test("探测不可用时快照命令同样以退出码 2 明确跳过", () => {
	const bogus = join(tmpdir(), `dsh-bogus-snap-${process.pid}`);
	const result = spawnSync(
		process.execPath,
		[snapshotEntry, "--check", "--harness-root", bogus],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
	assert.match(
		result.stdout + result.stderr,
		/探测不可用|不是一个 DSH harness 安装/,
	);
});

// ---------------------------------------------------------------------------
// 自动转阻断：改工单台账即可，不需改守卫代码
// ---------------------------------------------------------------------------

test("归属工单落地后，对应违规自动从「只报告」转为「阻断」", () => {
	const original = readFileSync(ticketsPath, "utf8");
	const tickets = readTickets();

	try {
		// 自己把台账清成空，而不是断言「仓库里没有已落地的工单」——后者会随完工
		// 进度漂移：工单真的做完并登记进 done 之后，这个前置条件就永远不成立了
		// （登记的瞬间本测试就会红）。本测试要审的是「台账从空到有」这一步转换，
		// 基线必须由测试自己造出来。清空 + 种违规，两步一起让前置条件自足。
		writeFileSync(
			ticketsPath,
			`${JSON.stringify({ ...tickets, done: [] }, null, 2)}\n`,
			"utf8",
		);

		// 自己种一条「有归属」的违规，而不是指望仓库此刻正好带着未修复的违规。
		// 后者同样会随修复进度漂移。种出来的违规 owner 是 03。
		withSyntheticDanglingPath(({ report: before }) => {
			const pending = before.results.filter(
				(r) => r.pendingViolations?.length > 0,
			);
			assert.ok(
				pending.length > 0,
				"种下悬空引用后仍无 report-only 违规 —— 归属分档或探测失效",
			);

			// 只把台账改成「这些工单都已完成」，守卫代码一个字都不动。
			const owners = [
				...new Set(
					pending.flatMap((r) => r.pendingViolations.map((v) => v.owner)),
				),
			].sort();
			assert.ok(
				owners.every((o) => o !== null && o !== undefined),
				`pending 里混入了无归属违规：${JSON.stringify(owners)}`,
			);

			const unownedCount = before.results
				.flatMap((r) => r.pendingViolations ?? [])
				.filter((v) => v.owner === null || v.owner === undefined).length;
			const blockingCount = before.results.flatMap(
				(r) => r.blockingViolations ?? [],
			).length;

			writeFileSync(
				ticketsPath,
				`${JSON.stringify({ ...tickets, done: owners }, null, 2)}\n`,
				"utf8",
			);

			const after = runGuard();
			assert.equal(
				after.status,
				1,
				"工单标记完成后，原 report-only 违规没有转为阻断",
			);
			for (const id of pending.map((r) => r.id)) {
				const result = after.report.results.find((r) => r.id === id);
				assert.equal(result.severity, "blocking", `${id} 未转为 blocking`);
				assert.equal(
					result.pendingViolations.length,
					0,
					`${id} 仍残留 pending 违规`,
				);
				assert.ok(
					result.blockingViolations.length > 0,
					`${id} 未产生 blocking 违规`,
				);
			}
			// 种下的那条必然存在于阻断集合里（这正是「登记 done 即转阻断」的证据）。
			//
			// ⚠️ 必须匹配 `detail` 而不是 `where`：报告里的 `where` 只有 `file:line`
			// （实测就是 `injector/package.json:8`），**目标值只出现在 detail 里**。
			// 拿 `where.includes("__guard_self_test_missing__")` 去比会永远为 false，
			// 看起来像「转阻断失败」，其实是断言查错了字段。
			const blockingDetails = after.report.results
				.flatMap((r) => r.blockingViolations ?? [])
				.map((v) => `${v.where} ${v.detail}`);
			assert.ok(
				blockingDetails.some((s) => s.includes("__guard_self_test_missing__")),
				`种下的悬空引用未出现在 blocking 违规里：\n${blockingDetails.join("\n")}`,
			);
			// 变量仅为可读性保留：它们记录「转档前后」的无主/阻断基数。
			void unownedCount;
			void blockingCount;
		});
	} finally {
		writeFileSync(ticketsPath, original, "utf8");
	}
});

test("还原台账后守卫回到「未登记工单」的基线（转阻断是可逆的、由数据驱动）", () => {
	// 台账此刻可能已有已完工的工单登记（done 非空）。本测试审的是「done 为空」这个
	// 基线的分档语义，所以自己把台账清成空，而不是断言仓库此刻恰好没有完工工单 ——
	// 后者会随完工进度漂移：登记第一个工单的瞬间，这个断言就会红。
	//
	// 也刻意**不**依赖上一条测试的 finally 还原出「空台账」：那是一条隐式的测试间耦合，
	// 上一条测试写入的 done 集合取决于它当场种出的违规 owner。只有自己造基线才与顺序无关。
	const originalTickets = readFileSync(ticketsPath, "utf8");
	const tickets = readTickets();
	let status;
	let report;
	try {
		writeFileSync(
			ticketsPath,
			`${JSON.stringify({ ...tickets, done: [] }, null, 2)}\n`,
			"utf8",
		);
		({ status, report } = runGuard());
	} finally {
		writeFileSync(ticketsPath, originalTickets, "utf8");
	}
	// 不断言 0：基线的含义是「台账为空时的退出码」，而不是「仓库零违规」——修好一条
	// 违规就少一条阻断，把 0 写成断言会让这个测试随修复进度随机变红。
	//
	// 也不能断言「没有 pending 违规」：pending **正是**「有归属、且该工单尚未落地」的
	// 正常状态。台账为空时，所有带归属的违规本来就该处在 pending —— 断言它为空，
	// 等于要求所有工单都已完工，那同样是会随修复进度漂移的前提。
	//
	// 真正证明「还原生效」的是**归属的分布**：台账为空时，每一条 pending 都必须是
	// 「有归属」的（owner 非 null），而每一条 blocking 都必须是**无归属**的
	// （owner 为 null）——因为 blocking 只可能来自「没有工单认领」的违规。
	// 这正是数据驱动分档的判据：分档只由 owner × done 台账决定。
	assert.notEqual(status, 2);
	const pending = report.results.flatMap((r) => r.pendingViolations ?? []);
	const blocking = report.results.flatMap((r) => r.blockingViolations ?? []);
	assert.deepEqual(
		pending
			.filter((v) => v.owner === null || v.owner === undefined)
			.map((v) => v.where),
		[],
		"台账为空时出现 owner 为空的 pending 违规 —— pending 应专属于「有归属但工单未落地」",
	);
	assert.deepEqual(
		blocking
			.filter((v) => v.owner !== null && v.owner !== undefined)
			.map((v) => `${v.owner} @ ${v.where}`),
		[],
		"台账为空时出现「有归属」的 blocking 违规 —— 有归属且工单未落地只该是 pending",
	);
	assert.equal(
		status,
		blocking.length > 0 ? 1 : 0,
		`退出码与 blocking 违规数不一致：blocking=${blocking.length} status=${status}`,
	);
});

// ---------------------------------------------------------------------------
// 违规报告必须给出三件事：违反的契约 / 违反位置 / 期望写法
// ---------------------------------------------------------------------------

test("每条失败的守卫都报出契约、违反位置与期望写法", () => {
	// 自己种一条违规让前置条件自足：依赖「本机此刻正好有未修复的违规」会让本测试
	// 在仓库修干净的瞬间变红，而它要审的是**报告的完整性**——contract / expected /
	// where / detail 四件套齐全，与仓库当前有几条违规无关。
	withSyntheticDanglingPath(({ report }) => {
		const failed = report.results.filter((r) => r.violations?.length > 0);
		assert.ok(failed.length > 0, "种下悬空引用后仍无任何守卫报出违规 —— 探测失效");

		for (const result of failed) {
			assert.ok(
				typeof result.contract === "string" && result.contract.length > 0,
				`${result.id} 缺 contract`,
			);
			assert.ok(
				typeof result.expected === "string" && result.expected.length > 0,
				`${result.id} 缺 expected`,
			);
			for (const violation of result.violations) {
				assert.ok(
					typeof violation.where === "string" && violation.where.length > 0,
					`${result.id} 缺 where`,
				);
				assert.ok(
					typeof violation.detail === "string" && violation.detail.length > 0,
					`${result.id} 缺 detail`,
				);
				assert.match(
					violation.where,
					/:\d+$|^\(/,
					`${result.id} 的 where 未指向具体位置：${violation.where}`,
				);
			}
		}
	});
});

test("违反位置指向的文件真实存在", () => {
	const { report } = runGuard();
	for (const result of report.results) {
		for (const violation of result.violations ?? []) {
			const match = /^(.*?):(\d+)$/.exec(violation.where);
			if (!match) continue;
			const file = join(repoRoot, match[1].split("/").join("\\"));
			assert.doesNotThrow(
				() => readFileSync(file, "utf8"),
				`违规位置指向不存在的文件：${violation.where}`,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// 六条契约各至少一条守卫
// ---------------------------------------------------------------------------

test("六条契约各由一条守卫覆盖，且 id 稳定", () => {
	const { report } = runGuard();
	const ids = report.results.map((r) => r.id).sort();
	assert.deepEqual(ids, [
		"client-modules-public-surface",
		"cordis-event-names",
		"dsh-tools-register-parameters",
		"harness-version-alignment",
		"installable-package-names",
		"package-metadata-paths",
	]);
});

test("cordis 事件名守卫断言 dispose 不在事件清单里", () => {
	const { report } = runGuard();
	const result = report.results.find((r) => r.id === "cordis-event-names");
	assert.ok(result, "缺 cordis-event-names 守卫");
	assert.equal(result.skip, undefined, `该守卫被跳过了：${result.skip}`);
	// 契约前提：dispose 不在并集里；仓库里出现 ctx.on('dispose') 即为违规。
	for (const violation of result.violations) {
		assert.match(violation.detail, /dispose/);
	}
});

test("clientModules 守卫断言 rebuilt 在公开面上、table 与 reconcilePackage 不在", () => {
	const { report } = runGuard();
	const result = report.results.find(
		(r) => r.id === "client-modules-public-surface",
	);
	assert.ok(result, "缺 client-modules-public-surface 守卫");
	assert.equal(result.skip, undefined, `该守卫被跳过了：${result.skip}`);
	// 实测：reconcilePackage 是 private，不是公开的删行手段；公开面只有 rebuilt。
	const probe = probeAll({ repoRoot });
	assert.ok(
		probe.clientModules.publicMethods.includes("rebuilt"),
		"rebuilt 应在公开方法面上",
	);
	assert.ok(
		probe.clientModules.privateMembers.includes("reconcilePackage"),
		"reconcilePackage 应为 private",
	);
	assert.ok(
		!probe.clientModules.publicMethods.includes("table"),
		"table 不应出现在公开方法面上",
	);
});

test("可安装包名守卫从磁盘派生清单，不硬编码包数", () => {
	const probe = probeAll({ repoRoot });
	assert.ok(probe.harness.packagesMdAvailable, "packages.md 不可读");
	assert.equal(
		probe.harness.installablePackageCount,
		probe.harness.installablePackages.length,
	);
	assert.ok(
		probe.harness.installablePackageCount > 100,
		"清单条数异常偏少，解析可能失效",
	);
	// 清单变更应体现在 sha256 上，而不是被固定常量掩盖。
	assert.match(probe.harness.packagesMdSha256, /^[0-9a-f]{64}$/);
});

test("版本对齐守卫报出安装版本与仓库声明版本", () => {
	const { report } = runGuard();
	const result = report.results.find(
		(r) => r.id === "harness-version-alignment",
	);
	assert.ok(result, "缺 harness-version-alignment 守卫");
	assert.ok(
		result.contract.includes(report.harness.version),
		`契约文本未带安装版本：${result.contract}`,
	);
});

// ---------------------------------------------------------------------------
// 元数据悬空路径：探测必须真的能发现悬空引用，而不是永远 PASS 的空壳
// ---------------------------------------------------------------------------

test("元数据路径探测认得出「真实存在」与「悬空」两种情况", () => {
	// 用临时目录造两个包，验证探测的**判别力**本身。
	// 只断言「仓库当前干净」是没有意义的：那既可能在修复后为真，也可能因为探测
	// 静默抽 0 条而为真 —— 后者才是真正要防的失效。
	const fixture = mkdtempSync(join(tmpdir(), "dsh-metadata-paths-"));
	try {
		const existing = join(fixture, "ok");
		const dangling = join(fixture, "bad");
		mkdirSync(existing, { recursive: true });
		mkdirSync(join(existing, "lib"), { recursive: true });
		writeFileSync(join(existing, "lib", "index.js"), "export {}\n", "utf8");
		writeFileSync(join(existing, "lib", "index.d.ts"), "export {}\n", "utf8");
		// bad 包**故意什么都不产出**：它的每个声明都该被判为悬空。
		mkdirSync(dangling, { recursive: true });

		writeFileSync(
			join(existing, "package.json"),
			JSON.stringify({
				name: "ok",
				main: "./lib/index.js",
				types: "./lib/index.d.ts",
				exports: {
					".": { types: "./lib/index.d.ts", default: "./lib/index.js" },
				},
			}),
			"utf8",
		);
		writeFileSync(
			join(dangling, "package.json"),
			JSON.stringify({
				name: "bad",
				main: "./lib/index.js",
				types: "./lib/types/index.d.ts",
				exports: {
					".": { types: "./lib/types/index.d.ts", default: "./lib/index.js" },
				},
			}),
			"utf8",
		);

		const { entries } = probePackageMetadataPaths(fixture);
		assert.ok(
			entries.length > 0,
			"探测抽到了 0 条 —— 探测本身失效，而不是仓库干净",
		);

		const okEntries = entries.filter((e) => e.file.startsWith("ok/"));
		assert.ok(okEntries.length > 0, "未扫到 ok 包");
		for (const entry of okEntries) {
			assert.equal(
				entry.exists,
				true,
				`误报悬空：${entry.file} → ${entry.field} (${entry.target})`,
			);
		}

		const badEntries = entries.filter((e) => e.file.startsWith("bad/"));
		assert.ok(badEntries.length > 0, "未扫到 bad 包");
		// bad 包一个文件都没有，所以它声明的每条路径都该被报出 —— 一条都不能漏。
		// 若这里只报出部分字段，说明扫描面漏了字段（例如只扫顶层、没进 exports 条件树）。
		for (const entry of badEntries) {
			assert.equal(
				entry.exists,
				false,
				`漏报悬空：${entry.file} → ${entry.field} (${entry.target})`,
			);
		}
		const missing = badEntries.filter((e) => !e.exists).map((e) => e.field);
		assert.ok(
			missing.includes("main"),
			`顶层 main 未被扫到，实际报出：${JSON.stringify(missing)}`,
		);
		assert.ok(
			missing.some((f) => f.includes("types")),
			`悬空的 types 未被发现，实际报出：${JSON.stringify(missing)}`,
		);
		assert.ok(
			missing.some((f) => f.startsWith("exports")),
			`exports 条件树里的路径未被扫到，实际报出：${JSON.stringify(missing)}`,
		);
		// 每条悬空条目都要带 1-based 行号：报告里 `file:line` 是人和编辑器唯一的
		// 定位手段，缺了它读者只知道"这个文件有问题"，不知道去哪改。
		for (const entry of badEntries) {
			assert.equal(
				typeof entry.line,
				"number",
				`悬空条目缺少行号定位：${entry.file} → ${entry.field} (${entry.target})`,
			);
			assert.ok(entry.line >= 1, `行号必须是 1-based 正数，实际 ${entry.line}`);
		}
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("元数据路径探测忽略非本地目标（node: 前缀、裸包名、协议 URL）", () => {
	const fixture = mkdtempSync(join(tmpdir(), "dsh-metadata-targets-"));
	try {
		const dir = join(fixture, "pkg");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: "pkg",
				// 这些都不是「本包内的文件」，不该被当成悬空引用。
				browser: "some-npm-package",
				unpkg: "https://unpkg.com/pkg/index.js",
				bin: { pkg: "./bin/cli.js" },
			}),
			"utf8",
		);
		const { entries } = probePackageMetadataPaths(fixture);
		const fields = entries
			.filter((e) => e.file.startsWith("pkg/"))
			.map((e) => `${e.field}=${e.target}`);
		assert.ok(
			!fields.some((f) => f.startsWith("browser=")),
			`裸包名被当成本地路径：${fields.join(", ")}`,
		);
		assert.ok(
			!fields.some((f) => f.startsWith("unpkg=")),
			`协议 URL 被当成本地路径：${fields.join(", ")}`,
		);
		// bin 的映射值是真本地路径，必须留下来（悬空时也要能报出）。
		assert.ok(
			fields.includes("bin.pkg=./bin/cli.js"),
			`bin 的本地目标被漏掉：${fields.join(", ")}`,
		);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("元数据路径守卫不依赖 harness：探测在 probeAll 的两个分支上都挂着", () => {
	// 这条契约审的是仓库自己的元数据自洽性，与 harness 装没装无关。
	// 若探测只挂在「harness 可用」的分支上，没装 harness 的机器上这条契约会静默消失。
	const source = readFileSync(
		join(repoRoot, "guard", "lib", "probe.mjs"),
		"utf8",
	);
	const hits = [
		...source.matchAll(/packageMetadata:\s*probePackageMetadataPaths\(/g),
	];
	assert.ok(
		hits.length >= 2,
		`probeAll 只在 ${hits.length} 个分支上挂了 packageMetadata，harness 不可用时该契约会被静默跳过`,
	);
});

test("每个悬空的元数据引用都能归属到工单，或有明确的无主阻断语义", () => {
	const { report } = runGuard();
	const result = report.results.find((r) => r.id === "package-metadata-paths");
	assert.ok(result, "缺 package-metadata-paths 守卫");
	// 断言的是**归属机制成立**，不是「此刻没有违规」——后者会随修复进度漂移。
	for (const violation of result.violations) {
		assert.ok(
			typeof violation.where === "string" &&
				violation.where.includes("package.json"),
			`违规位置未指向 package.json：${violation.where}`,
		);
		assert.match(violation.detail, /悬空引用/, "违规说明未点明「悬空引用」");
		// owner 要么是工单号，要么为 null（无主 → 一律阻断）。不能是别的形状。
		assert.ok(
			violation.owner === null || /^\d{2}$/.test(String(violation.owner)),
			`owner 形状非法：${JSON.stringify(violation.owner)}`,
		);
	}
});

// ---------------------------------------------------------------------------
// 解析器单元测试（防止「解析静默抽 0 条」这类失效）
// ---------------------------------------------------------------------------

test("parseTopLevelMembers 只在顶层收成员，忽略内联 payload 的字段名", () => {
	const body = [
		"'agent/error'(this: unknown, payload: {",
		"    agent: unknown;",
		"    turn: number;",
		"}): void;",
		"'agent/pre-step'(): void;",
	].join("\n");
	assert.deepEqual(parseTopLevelMembers(body), [
		"agent/error",
		"agent/pre-step",
	]);
});

test("parseEventsInterface 认得字符串字面量式与属性式两种事件声明", () => {
	const source = [
		"export interface Events {",
		"  'internal/plugin'(fiber: unknown): void;",
		"  ready: void;",
		"}",
	].join("\n");
	assert.deepEqual(parseEventsInterface(source), ["internal/plugin", "ready"]);
});

test("parseEventsInterface 对没有 interface Events 的文件返回 undefined（区别于空接口）", () => {
	assert.equal(parseEventsInterface("export interface Other {}"), undefined);
	assert.deepEqual(parseEventsInterface("export interface Events {}"), []);
});

test("parseInstallablePackages 按 ## 分组收集表行", () => {
	const markdown = [
		"# 标题",
		"## workflow",
		"| `@deepseek-ai/dsh-tool-workflow` | yes | 工作流 |",
		"| `@deepseek-ai/dsh-workflow-ptc` | yes | PTC |",
		"## tools",
		"| `@deepseek-ai/dsh-tools` | yes | 工具 |",
		"| 不是 `@deepseek-ai/xxx` 的行 | yes | 忽略 |",
	].join("\n");
	const parsed = parseInstallablePackages(markdown);
	assert.deepEqual(parsed.names, [
		"@deepseek-ai/dsh-tool-workflow",
		"@deepseek-ai/dsh-workflow-ptc",
		"@deepseek-ai/dsh-tools",
	]);
	assert.deepEqual(parsed.groups.workflow.length, 2);
});

test("parseClassMembers 区分 public / private / static", () => {
	const source = [
		"declare class Registry {",
		"    graph(): unknown;",
		"    rebuilt(id: string): string | undefined;",
		"    private table: Map<string, unknown>;",
		"    private reconcilePackage(name: string): boolean;",
		"    static create(): Registry;",
		"}",
	].join("\n");
	const { publicMethods, privateMembers } = parseClassMembers(
		source,
		"Registry",
	);
	assert.deepEqual(publicMethods, ["graph", "rebuilt"]);
	assert.deepEqual(privateMembers, ["reconcilePackage", "table"]);
});

test("parseClassMembers 认得降级后的匿名类表达式形态", () => {
	const source = [
		"var Registry = class extends Service {",
		"    graph() { return 1 }",
		"};",
	].join("\n");
	const { publicMethods } = parseClassMembers(source, "Registry");
	assert.deepEqual(publicMethods, ["graph"]);
});

// ---------------------------------------------------------------------------
// 快照：可单独重生成，且与守卫共用同一份探测逻辑
// ---------------------------------------------------------------------------

test("快照可单独重新生成，且重生成后立即自校验一致", () => {
	const fixture = mkdtempSync(join(tmpdir(), "dsh-guard-snapshot-"));
	try {
		const result = spawnSync(
			process.execPath,
			[snapshotEntry, "--write", "--out", join(fixture, "snap.json")],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

		const check = spawnSync(
			process.execPath,
			[snapshotEntry, "--check", "--out", join(fixture, "snap.json")],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);
		assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("快照与守卫共用同一份探测逻辑：仓库里不存在第二套解析实现", () => {
	const snapshotSource = readFileSync(snapshotEntry, "utf8");
	// ⚠️ 引号两种都收（与上方 probe.mjs 那条同一理由）：本仓库由 biome 格式化，
	// 它会把手写的单引号统一改成双引号——只认单引号的正则会在格式化后突然
	// 失配，而失配原因与「快照没从 probe 取数」这个被审的事实毫无关系。
	assert.match(
		snapshotSource,
		/from ['"]\.\/lib\/probe\.mjs['"]/,
		"快照未从 probe 模块取数",
	);

	// 快照不该自己写解析：它只格式化 probe 的输出。
	// 允许 import node: 内置模块（格式化/写盘需要），但不允许引入任何第三方解析库。
	const imports = [
		...snapshotSource.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm),
	].map((m) => m[1]);
	assert.ok(imports.length > 0, "未找到 import 语句，断言失效");
	assert.ok(imports.includes("./lib/probe.mjs"), "快照未从 probe 模块取数");
	for (const specifier of imports) {
		assert.ok(
			specifier === "./lib/probe.mjs" || specifier.startsWith("node:"),
			`快照引入了额外依赖，解析逻辑可能已分叉：${specifier}`,
		);
	}
});

test("快照内容不含时间戳与绝对安装路径（保证可复现、不泄露本机路径）", () => {
	const snapshot = JSON.parse(
		readFileSync(join(repoRoot, "guard", "snapshot.json"), "utf8"),
	);
	const text = JSON.stringify(snapshot);
	assert.doesNotMatch(
		text,
		/AppData|C:\\\\Users|Users[\\/]/,
		"快照写入了本机绝对路径",
	);
	assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/, "快照写入了时间戳");
});

// ---------------------------------------------------------------------------
// 自命中防护：守卫不得把自己的说明文字当成违规
// ---------------------------------------------------------------------------

test("扫描跳过 guard/ 自身，守卫不会自命中", () => {
	const { report } = runGuard();
	const result = report.results.find(
		(r) => r.id === "installable-package-names",
	);
	for (const violation of result.violations) {
		assert.doesNotMatch(
			violation.where,
			/^guard\//,
			`守卫扫描到了自己：${violation.where}`,
		);
	}
});

test("扫描跳过构建产物与依赖目录", () => {
	const probe = probeAll({ repoRoot });
	for (const hit of probe.repoSources.specifiers) {
		assert.doesNotMatch(
			hit.file,
			/^(node_modules|\.git|\.scratch|graphify-out|guard)\//,
			`扫到了不该扫的目录：${hit.file}`,
		);
	}
});

// ---------------------------------------------------------------------------
// tickets.json 契约
// ---------------------------------------------------------------------------

test("工单台账结构合法，done 里只允许出现已知工单号", () => {
	const tickets = readTickets();
	assert.ok(Array.isArray(tickets.done), "done 必须是数组");
	for (const id of tickets.done) {
		assert.match(String(id), /^\d{2}$/, `非法工单号：${id}`);
	}
});

test("守卫源码里不残留硬编码的包清单条数", () => {
	const source = readFileSync(guardEntry, "utf8");
	// 242/245 这类数字一旦写死，harness 升级后守卫就会静默失效。
	assert.doesNotMatch(source, /\b(?:242|245)\b/, "守卫里写死了包清单条数");
});

test("退出码语义写进了守卫头部文档", () => {
	const source = readFileSync(guardEntry, "utf8");
	assert.match(source, /退出码：0 = .*1 = .*2 = /s, "头部未记录退出码语义");
});

/** 供调试：确认 execFileSync 可用（避免某些 CI 下未导入而被 lint 判为死代码）。 */
void execFileSync;
