/**
 * 工单 11 — graded 生命周期清理 + 请求校验（HTTP 查询参数分支）。
 *
 * 两条链路都在这里对**真实 apply() 装配出来的上下文**做断言，而不是断言源码文本：
 *   ① 清理回调必须走 cordis 支持的副作用通道（ctx.effect 返回 disposer）——
 *      装配后把插件 fiber 卸载 → 会话态 activeSid 必须被清空。
 *   ② `GET /graded-mode/api?sid=` 的三元分支——显式 sid 有盘档 → ok:true；
 *      显式 sid 无盘档 → ok:false/reason:no-state，不得用空状态冒充。
 *
 * 依赖解析：仓库根 node_modules 未安装 harness 包，`../src/index.js` 的第一行
 * `import z from '@deepseek-ai/schemastery'` 会解析失败。这里按「注入器热重载通道」
 * 的实际形态解析同款模块：进程内没有可用副本时，从 DSH 安装树 link 一份到运行时
 * 暂存目录（见 ensureRuntimeDeps），测试结束即删。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcIndex = join(repoRoot, "graded", "src", "index.js");
const RUNTIME_PKGS = ["@deepseek-ai/schemastery"];

/** DSH 安装树候选（不硬编码用户名：从环境变量与 `dsh` 可执行文件位置推导）。 */
function installTreeCandidates() {
	const out = [];
	const appData = process.env.APPDATA;
	if (appData)
		out.push(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh"));
	if (process.env.DSH_HOME)
		out.push(join(process.env.DSH_HOME, "node_modules", "@deepseek-ai", "dsh"));
	// PATH 上的 dsh 启动脚本 → 包根
	for (const raw of String(process.env.PATH || "").split(
		process.platform === "win32" ? ";" : ":",
	)) {
		if (!raw) continue;
		const p = join(raw, "node_modules", "@deepseek-ai", "dsh");
		if (existsSync(p)) out.push(p);
	}
	return out;
}

/**
 * 解析插件运行时依赖。
 *
 * 优先用进程内可见的副本（真实 DSH 进程 / 已装 node_modules）——这种情形**不创建
 * 任何暂存目录**。只有进程内不可见时才从安装树 link 一份（junction，免复制）。
 *
 * @returns {{runtimeDir: string|null, injector: (parentUrl: string) => Promise<Function>}}
 */
function ensureRuntimeDeps() {
	let runtimeDir = null;
	const probe = createRequire(import.meta.url);
	let allVisible = true;
	for (const spec of RUNTIME_PKGS) {
		try {
			probe.resolve(spec);
		} catch {
			allVisible = false;
		}
	}
	if (!allVisible) {
		const tree = installTreeCandidates().find((p) =>
			existsSync(join(p, "node_modules")),
		);
		if (tree) {
			runtimeDir = mkdtempSync(join(tmpdir(), "graded-w11-"));
			mkdirSync(join(runtimeDir, "node_modules", "@deepseek-ai"), {
				recursive: true,
			});
			for (const spec of RUNTIME_PKGS) {
				const target = join(tree, "node_modules", spec);
				if (!existsSync(target)) continue;
				try {
					symlinkSync(
						target,
						join(runtimeDir, "node_modules", spec),
						"junction",
					);
				} catch {
					/* 已存在/权限不足 → 退回解析失败，由测试用例自述 */
				}
			}
			writeFileSync(
				join(runtimeDir, "package.json"),
				'{"type":"module"}',
				"utf8",
			);
		}
	}
	return {
		runtimeDir,
		/** 在「以 parentUrl 为基准」的解析路径下加载插件入口。 */
		injector(parentUrl) {
			const req = createRequire(parentUrl);
			for (const spec of RUNTIME_PKGS) {
				if (!runtimeDir) continue;
				req(spec); // 预热：把暂存目录挂进 require 解析路径
			}
			return import(pathToFileURL(srcIndex).href);
		},
	};
}

const runtime = ensureRuntimeDeps();
// 让 `@deepseek-ai/schemastery` 从暂存目录可解析：以暂存目录为基准创建一个 require，
// 再把它的解析路径交给 src 入口（等价于 DSH 进程里 `graded/` 是被 link 进 node_modules 的）。
if (runtime.runtimeDir) {
	const req = createRequire(join(runtime.runtimeDir, "index.js"));
	globalThis.__gradedW11Resolve = req.resolve;
	if (!process.env.NODE_PATH)
		process.env.NODE_PATH = join(runtime.runtimeDir, "node_modules");
}

/** 载入插件模块（依赖不可解析时给出具名失败，而不是莫名 ENOENT）。 */
let mod = null;
let modError = null;
try {
	mod = await import(pathToFileURL(srcIndex).href);
} catch (e) {
	modError = e;
}

test("插件入口可加载（依赖可解析）", () => {
	if (modError) {
		// 依赖不可解析时明确说出缺什么，避免后续用例报"apply is not a function"
		assert.fail(`无法加载 graded/src/index.js：${modError.message}`);
	}
	assert.equal(typeof mod.apply, "function");
});

/* ---------- 伪 cordis 上下文：只实现插件真正用到的那部分 fiber API ---------- */

function createFakeCtx() {
	const disposers = [];
	const registered = [];
	const events = [];
	const ctx = {
		// 本插件声明的服务（inject: commands/userQuestions/webServer/tools）
		commands: {
			register: (def) => {
				registered.push({ kind: "command", def });
				return () => {};
			},
		},
		userQuestions: { ask: async () => ({ answers: [] }) },
		tools: {
			register: (def) => {
				registered.push({ kind: "tool", name: def?.name, def });
				return () => {};
			},
		},
		webServer: {
			register: (def, label) => {
				registered.push({ kind: "route", path: def?.path, def, label });
				return () => {};
			},
		},
		on(name, fn) {
			events.push({ name, fn });
			return () => {};
		},
		// cordis 真实公开 API：副作用注册，返回的销毁函数在 fiber 卸载时执行。
		effect(execute, label) {
			const disposer = execute();
			if (typeof disposer === "function")
				disposers.push({ label, fn: disposer });
			return () => {};
		},
		get(name) {
			return ctx[name];
		},
	};
	return {
		ctx,
		registered,
		events,
		/** 模拟「插件卸载」：按 fiber 语义执行全部 effect disposer。 */
		unload() {
			for (const d of [...disposers].reverse()) d.fn();
		},
		disposedCount: () => disposers.length,
	};
}

/** 收集 handler 注册的真实路由，返回一个能在进程内驱动它们的假 Request/Response。 */
function routesFrom(registered) {
	const routes = new Map();
	for (const r of registered)
		if (r.kind === "route") routes.set(r.path, r.def.handler);
	return routes;
}

function callHandler(handler, url, method = "GET") {
	return new Promise((resolvePromise, rejectPromise) => {
		const chunks = [];
		const fakeReq = {
			url,
			method,
			async *[Symbol.asyncIterator]() {
				/* 本用例不发送 body */
			},
		};
		const fakeRes = {
			statusCode: 0,
			headers: null,
			writeHead(code, headers) {
				this.statusCode = code;
				this.headers = headers;
				return this;
			},
			end(payload) {
				chunks.push(payload);
				try {
					resolvePromise({
						status: this.statusCode,
						headers: this.headers,
						body: JSON.parse(chunks.join("")),
					});
				} catch (e) {
					rejectPromise(e);
				}
			},
		};
		Promise.resolve(handler(fakeReq, fakeRes)).catch(rejectPromise);
	});
}

/* ---------- 语料 ---------- */

const SID = "session-w11-probe";
const TASK = "工单11 生命周期与请求校验探针";

/** 造一份真实盘档（graded-state/<sid>.json），通过 DSH_HOME 指向临时目录。 */
function withStateHome(fn, { persist = true } = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "graded-w11-home-"));
	const oldHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tmp;
	try {
		if (persist) {
			mkdirSync(join(tmp, "graded-state"), { recursive: true });
			writeFileSync(
				join(tmp, "graded-state", `${SID}.json`),
				JSON.stringify({
					stage: "l1-edit",
					task: TASK,
					mode: "correct",
					star: null,
					l1Locked: false,
					l2Locked: false,
					injected: [],
					plan: {
						groups: [
							{
								title: "A",
								locked: false,
								items: [{ title: "a1", status: "pending" }],
							},
						],
					},
				}),
				"utf8",
			);
		}
		return fn(tmp);
	} finally {
		if (oldHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = oldHome;
		rmSync(tmp, { recursive: true, force: true });
	}
}

/* ---------- ① 生命周期清理 ---------- */

test("卸载清理：ctx.effect 注册 disposer，卸载后 activeSid 被清空（不再依赖不存在的 dispose 事件）", async () => {
	const app = createFakeCtx();
	await withStateHome(async () => {
		mod.apply(app.ctx, {});

		// 前置：插件绝不能把清理回调挂到不存在的事件名上
		const names = app.events.map((e) => e.name);
		assert.ok(
			!names.includes("dispose"),
			`不得再监听不存在的 'dispose' 事件（当前监听：${names.join(", ")}）`,
		);
		assert.ok(
			app.disposedCount() >= 1,
			"应至少注册一个 effect disposer 承担卸载清理",
		);

		// 驱动 agent/pre-step（插件里唯一把 activeSid = agent.session.id 的常规通道），
		// 再借 /graded-mode/api 的 sidShort 字段当侧信道读出 activeSid。
		const preStep = app.events.find((e) => e.name === "agent/pre-step");
		assert.ok(
			preStep,
			`未注册 agent/pre-step 事件（已注册：${app.events.map((e) => e.name).join(", ")}）`,
		);
		await preStep.fn(
			{ agent: { session: { id: SID } }, messages: [] },
			async () => ({ messages: [] }),
		);

		// 侧信道只用「无 ?sid=」的调用：显式 ?sid= 会让 sid 直接取查询参数，
		// 读不出 activeSid 是否被写入/清空。
		const routes = routesFrom(app.registered);
		const apiPath = "/graded-mode/api";
		assert.ok(
			routes.has(apiPath),
			`未注册 ${apiPath} 路由（已注册：${[...routes.keys()].join(", ")}）`,
		);

		const probe = async () =>
			(await callHandler(routes.get(apiPath), apiPath)).body;
		const before = await probe();
		assert.equal(before.sid, SID, "无 ?sid= 时 activeSid 应作为兜底会话被采纳");
		assert.equal(
			before.sidShort,
			SID.replace(/^session-/, "").slice(0, 8),
			"侧信道确认 activeSid 已被 agent/pre-step 写入（sidShort 由 activeSid 派生）",
		);

		// 模拟插件卸载
		app.unload();

		// 卸载后清空 → 既不参与兜底（sid 回落到盘档 mtime 最新），sidShort 也回到 null
		const after = await probe();
		assert.equal(after.sidShort, null, "卸载后 activeSid 必须被清空");
		assert.notEqual(after.sid, SID, "卸载后 activeSid 不得再作为兜底会话");
		assert.equal(after.ok, true, "清空 activeSid 不影响回退链的正常履约");
	});
});

test("卸载清理：卸载前 activeSid 不泄漏到别的会话（正常路径行为不变）", async () => {
	const app = createFakeCtx();
	await withStateHome(async () => {
		mod.apply(app.ctx, {});
		const routes = routesFrom(app.registered);
		const apiPath = "/graded-mode/api";
		// 未驱动任何会话时 sidShort 为 null（activeSid 初始值）
		const r = await callHandler(routes.get(apiPath), `${apiPath}?sid=${SID}`);
		assert.equal(r.body.sidShort, null);
		assert.equal(r.body.ok, true);
	});
});

/* ---------- ② 查询参数校验（两个分支） ---------- */

test("查询参数校验：显式 sid 且盘档存在 → ok:true（正常路径不变）", async () => {
	const app = createFakeCtx();
	await withStateHome(async () => {
		mod.apply(app.ctx, {});
		const routes = routesFrom(app.registered);
		const r = await callHandler(
			routes.get("/graded-mode/api"),
			`/graded-mode/api?sid=${SID}`,
		);
		assert.equal(r.body.ok, true);
		assert.equal(r.body.sid, SID, "应回报显式指定的 sid");
		assert.equal(r.body.stage, "l1-edit", "应回报该会话的真实盘档阶段");
		assert.equal(r.body.task, TASK);
		assert.equal(r.body.reason, undefined);
	});
});

test("查询参数校验：显式 sid 但磁盘无档案 → ok:false / reason:no-state（防护必须生效）", async () => {
	const app = createFakeCtx();
	await withStateHome(async () => {
		mod.apply(app.ctx, {});
		const routes = routesFrom(app.registered);
		const missing = "session-does-not-exist-w11";
		const r = await callHandler(
			routes.get("/graded-mode/api"),
			`/graded-mode/api?sid=${missing}`,
		);
		assert.equal(
			r.body.ok,
			false,
			"显式 sid 无盘档时必须报异常，不得用空状态冒充",
		);
		assert.equal(r.body.reason, "no-state");
		assert.equal(r.body.sid, missing);
		assert.equal(
			r.body.stage,
			undefined,
			"不渲染任何进度字段（客户端不显示错会话徽章）",
		);
	});
});

test('查询参数校验：未带 sid 时不触发"无盘档"判定（回退链正常）', async () => {
	const app = createFakeCtx();
	await withStateHome(async () => {
		mod.apply(app.ctx, {});
		const routes = routesFrom(app.registered);
		const r = await callHandler(
			routes.get("/graded-mode/api"),
			"/graded-mode/api",
		);
		assert.equal(
			r.body.ok,
			true,
			"未显式指定 sid 时应走回退链，不因缺少 ?sid= 而报 no-state",
		);
		assert.notEqual(r.body.reason, "no-state");
	});
});

test.after(() => {
	if (runtime.runtimeDir)
		rmSync(runtime.runtimeDir, { recursive: true, force: true });
});
