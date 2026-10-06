/**
 * 权威接口快照生成器 —— 可单独重新生成，且与守卫**共用同一份探测逻辑**。
 *
 * 用法：
 *   node guard/snapshot.mjs              # 打印快照到 stdout
 *   node guard/snapshot.mjs --write      # 写入 guard/snapshot.json
 *   node guard/snapshot.mjs --check      # 与已存快照比对，不一致 → 退出码 1
 *   node guard/snapshot.mjs --harness-root <path>
 *
 * 这里**没有**任何解析代码：全部数据来自 `guard/lib/probe.mjs`。工单 01 明确要求
 * 「权威接口快照可单独重新生成，并与守卫共用同一份探测逻辑（不允许两套解析实现）」，
 * 所以本文件只做「取探测结果 → 序列化 → 落盘」。
 *
 * 退出码：0 = 正常；1 = `--check` 发现漂移；2 = 探测不可用（harness 不在本机）。
 *
 * @module snapshot
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { probeAll, repoRoot } from "./lib/probe.mjs";

/** 快照落盘位置（仓库相对）。 */
export const SNAPSHOT_RELATIVE = "guard/snapshot.json";

/**
 * 构造快照对象。
 *
 * 只保留**契约相关**的稳定字段：版本、清单指纹、各接口的形状。刻意不写入探测
 * 时间戳与绝对安装路径 —— 前者会让每次生成都产生 diff，后者会让快照绑死本机。
 *
 * @param {object} [options]
 * @param {string} [options.harnessRoot] 显式 harness 安装根。
 * @returns {object} 快照对象。
 */
export function buildSnapshot(options = {}) {
	const probe = probeAll(options);
	if (!probe.harness.available) {
		return { available: false, reason: probe.harness.reason };
	}

	const harness = probe.harness;
	const core = probe.cordisEvents;
	const events = probe.harnessEvents;
	const tools = probe.dshToolsRegister;
	const disposal = probe.toolDisposal;
	const clientModules = probe.clientModules;
	const loaderResolution = probe.loaderResolution;

	return {
		available: true,
		harness: {
			version: harness.version,
			packagesMdSha256: harness.packagesMdSha256,
			installablePackageCount: harness.installablePackageCount,
			installablePackageGroups: Object.keys(
				harness.installablePackageGroups ?? {},
			).sort(),
		},
		cordisEvents: {
			eventsPath: core.eventsPath,
			events: core.events,
		},
		harnessEvents: {
			// 并集必须来自磁盘实测：harness 新增事件包时快照会跟着变，守卫与快照不会脱节。
			scannedFiles: events.scanned,
			sourceCount: events.sources?.length ?? 0,
			sources: Object.fromEntries(
				(events.sources ?? []).map((s) => [s.file, s.events]),
			),
			events: events.events,
		},
		dshToolsRegister: tools.available
			? {
					indexPath: tools.indexPath,
					registerValidatesOutputSchema: tools.registerValidatesOutputSchema,
					registerValidatesParameters: tools.registerValidatesParameters,
					defineToolCompilesParameters: tools.defineToolCompilesParameters,
				}
			: { available: false, reason: tools.reason },
		toolDisposal: disposal.available
			? {
					indexPath: disposal.indexPath,
					exportsUnregister: disposal.exportsUnregister,
					serviceHasUnregister: disposal.serviceHasUnregister,
				}
			: { available: false, reason: disposal.reason },
		clientModules: clientModules.available
			? {
					typesPath: clientModules.typesPath,
					class: clientModules.class,
					publicMethods: clientModules.publicMethods,
					privateMembers: clientModules.privateMembers,
				}
			: { available: false, reason: clientModules.reason },
		// 预设运行时行的解析锚点与**锚定递归条件**。
		//
		// 本仓库三个 preset 的运行时行是**裸包名子路径**
		// （`@dsh-external/dsh-preset-router-<id>/router-bootstrap-vNN.mjs`），经各自
		// bundle/package.json 的 exports 映射解析 —— 与官方每个预设补丁一致。
		//
		// 为什么不能用相对行：`anchorInsertedPluginNames`（dsh-app-boot）只重写它经
		// `entry.group && Array.isArray(entry.config)` 能走到的 `name` 字段，而预设的
		// 运行时行嵌在 `insert[].config.plugins[].name`（config 是对象）里 → 永不被锚定
		// → Loader 按 `ctx.baseUrl`（= profile 目录）解析 → ERR_MODULE_NOT_FOUND，
		// 整个预设静默不加载。三个预设曾全部因此失败。
		// 而裸包名子路径**不能**带 `?v=NN`：exports 精确匹配 → ERR_PACKAGE_PATH_NOT_EXPORTED。
		//
		// 所以这里把「锚点在哪」和「递归条件是什么」都存进快照：上游一改，`--check`
		// 立刻漂移 —— 那正是重新评估上述约束的时机。
		loaderResolution: loaderResolution.available
			? {
					bootPath: loaderResolution.bootPath,
					loaderPath: loaderResolution.loaderPath,
					anchorsAtPatchDir: loaderResolution.anchorsAtPatchDir,
					resolvesRelativeAgainstBaseUrl:
						loaderResolution.resolvesRelativeAgainstBaseUrl,
					hasCordisBuiltins: loaderResolution.hasCordisBuiltins,
					anchorsOnlyGroupArrayConfig:
						loaderResolution.anchorsOnlyGroupArrayConfig,
					anchorsConfigPlugins: loaderResolution.anchorsConfigPlugins,
				}
			: { available: false, reason: loaderResolution.reason },
	};
}

/** 稳定序列化：2 空格缩进 + 末尾换行，保证 diff 可读且幂等。 */
export function serializeSnapshot(snapshot) {
	return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** 命令行入口。 */
function main() {
	const argv = process.argv.slice(2);
	const write = argv.includes("--write");
	const check = argv.includes("--check");
	const rootIndex = argv.indexOf("--harness-root");
	const harnessRoot = rootIndex === -1 ? undefined : argv[rootIndex + 1];

	const snapshot = buildSnapshot({ harnessRoot });

	if (!snapshot.available) {
		process.stderr.write(`⚠ 探测不可用：${snapshot.reason}\n`);
		process.stderr.write(
			"  本机没有可读的 harness 安装，无法生成或比对权威接口快照。\n",
		);
		process.exitCode = 2;
		return;
	}

	const serialized = serializeSnapshot(snapshot);
	const target = join(repoRoot, SNAPSHOT_RELATIVE);

	if (check) {
		let existing;
		try {
			existing = readSnapshotFile(target);
		} catch (error) {
			process.stderr.write(`✗ 读取已存快照失败：${error?.message ?? error}\n`);
			process.exitCode = 1;
			return;
		}
		if (existing === undefined) {
			process.stderr.write(
				`✗ 快照不存在：${SNAPSHOT_RELATIVE}。先跑 \`node guard/snapshot.mjs --write\`。\n`,
			);
			process.exitCode = 1;
			return;
		}
		if (existing === serialized) {
			process.stdout.write(`✓ 快照与当前 harness 一致：${SNAPSHOT_RELATIVE}\n`);
			process.exitCode = 0;
			return;
		}
		process.stderr.write(`✗ 快照已漂移：${SNAPSHOT_RELATIVE}\n`);
		process.stderr.write(
			"  harness 接口与本仓库记录的形状不一致。核对后跑 `node guard/snapshot.mjs --write` 更新。\n",
		);
		for (const line of firstDiff(existing, serialized))
			process.stderr.write(`  ${line}\n`);
		process.exitCode = 1;
		return;
	}

	if (write) {
		writeFileSync(target, serialized, "utf8");
		process.stdout.write(`✓ 已写入快照：${SNAPSHOT_RELATIVE}\n`);
		process.stdout.write(`  harness 版本：${snapshot.harness.version}\n`);
		process.stdout.write(
			`  可安装包条目：${snapshot.harness.installablePackageCount}\n`,
		);
		process.stdout.write(
			`  事件并集：${snapshot.harnessEvents.events.length} 个（来自 ${snapshot.harnessEvents.sourceCount} 个事件源）\n`,
		);
		process.exitCode = 0;
		return;
	}

	process.stdout.write(serialized);
	process.exitCode = 0;
}

/** 读已存快照文本，不存在返回 `undefined`。 */
function readSnapshotFile(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * 找出两份文本的第一处差异，便于人工核对漂移点。
 *
 * @param {string} a 已存快照。
 * @param {string} b 当前探测结果。
 * @returns {string[]} 最多两行描述。
 */
function firstDiff(a, b) {
	const left = a.split("\n");
	const right = b.split("\n");
	const limit = Math.max(left.length, right.length);
	for (let i = 0; i < limit; i += 1) {
		if (left[i] === right[i]) continue;
		return [
			`首个差异在第 ${i + 1} 行：`,
			`  已存：${left[i] ?? "(缺行)"}`,
			`  当前：${right[i] ?? "(缺行)"}`,
		];
	}
	return ["（两份文本逐行相同，差异可能只在行尾空白）"];
}

main();
