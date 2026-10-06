#!/usr/bin/env node
/**
 * 校验三个 router 预设 bundle 的「运行时行能否被 loader 解析」。
 *
 * 为什么需要它：预设的运行时行嵌在 `cordis.patch.yml` 的
 * `insert[].config.plugins[].name` 里。`anchorInsertedPluginNames`
 * （`@deepseek-ai/dsh-app-boot`）只重写它经
 * `entry.group && Array.isArray(entry.config)` 能走到的 `name` 字段 ——
 * 相对行 `./x.mjs` 在这个位置**永不被锚定**，loader 于是按 **profile 目录**
 * 解析，报 `ERR_MODULE_NOT_FOUND`，整个预设静默不加载（实测：三个预设曾
 * 全部因此失败）。所以运行时行必须是**裸包名子路径**，经本包 `package.json`
 * 的 `exports` 映射解析 —— 这也是官方每个预设补丁的做法。
 *
 * 而裸包名子路径**不能**带 `?v=` 查询串：`exports` 是精确匹配，带查询直接报
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`。（缓存破坏也不需要了：bundle patch 只在
 * DSH 启动时读取，重启既重读补丁也丢弃 ESM 缓存。）
 *
 * 用法：`node preset/scripts/check-bundles.cjs [仓库根]`
 * 退出码：0 = 全部就位；1 = 有不一致；2 = 用法/环境错误。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PRESETS = ["router-standard", "router-react", "router-spec"];

const repoRoot = path.resolve(
	process.argv[2] ?? path.join(__dirname, "..", ".."),
);
const presetRoot = path.join(repoRoot, "preset");

if (!fs.existsSync(presetRoot)) {
	console.error(`check-bundles: 找不到 preset 目录：${presetRoot}`);
	process.exit(2);
}

/** 去掉 YAML 行尾注释与引号，返回 `name:` 的值；非 name 行返回 undefined。 */
function nameValue(line) {
	const m = /^\s*(?:-\s*)?name:\s*(.*)$/.exec(line);
	if (!m) return undefined;
	let v = m[1].trim();
	// 去掉 YAML 注释（裸包名/相对路径里不会出现 #）
	const hash = v.indexOf(" #");
	if (hash >= 0) v = v.slice(0, hash).trim();
	if (
		(v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
		(v.startsWith("'") && v.endsWith("'") && v.length > 1)
	) {
		v = v.slice(1, -1);
	}
	return v;
}

let failed = 0;
const problems = [];
const oks = [];

for (const name of PRESETS) {
	const dir = path.join(presetRoot, name, "bundle");
	const patchPath = path.join(dir, "cordis.patch.yml");
	const pkgPath = path.join(dir, "package.json");

	if (!fs.existsSync(patchPath)) {
		problems.push(`${name}: 缺少 bundle/cordis.patch.yml`);
		failed = 1;
		continue;
	}
	if (!fs.existsSync(pkgPath)) {
		problems.push(`${name}: 缺少 bundle/package.json（无法校验 exports 声明）`);
		failed = 1;
		continue;
	}

	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	} catch (err) {
		problems.push(`${name}: bundle/package.json 解析失败：${err.message}`);
		failed = 1;
		continue;
	}
	const exported = new Set(Object.keys(pkg.exports ?? {}));
	const selfName = typeof pkg.name === "string" ? pkg.name : undefined;

	for (const line of fs.readFileSync(patchPath, "utf8").split(/\r?\n/)) {
		if (/^\s*#/.test(line)) continue;
		const value = nameValue(line);
		if (value === undefined || value === "") continue;

		if (value.startsWith("./") || value.startsWith("../")) {
			problems.push(
				`${name}: 仍用相对模块行 \`${value}\` —— 它嵌在 config.plugins[] 里永不被锚定，` +
					`会按 profile 目录解析而 ERR_MODULE_NOT_FOUND；请改用裸包名`,
			);
			failed = 1;
			continue;
		}
		if (value.startsWith("cordis:") || path.isAbsolute(value)) continue;
		if (!value.startsWith("@") && !value.includes("/")) continue; // 裸包名（非子路径）

		if (selfName === undefined || !value.startsWith(`${selfName}/`)) continue;
		const subpath = value.slice(selfName.length + 1);
		const query = subpath.indexOf("?");
		if (query >= 0) {
			problems.push(
				`${name}: ${value} 带查询串 —— exports 精确匹配，会报 ERR_PACKAGE_PATH_NOT_EXPORTED`,
			);
			failed = 1;
			continue;
		}
		if (!exported.has(`./${subpath}`)) {
			problems.push(
				`${name}: ${value} 未在 bundle/package.json 的 exports 里声明 \`./${subpath}\``,
			);
			failed = 1;
			continue;
		}
		const file = path.join(dir, subpath);
		if (!fs.existsSync(file)) {
			problems.push(`${name}: ${value} 指向的文件缺失（${file}）`);
			failed = 1;
			continue;
		}
		oks.push(`${name}: ${value} 已声明且就位`);
	}
}

for (const line of oks) console.log(`OK: ${line}`);
for (const line of problems) console.error(`FAIL: ${line}`);

if (failed !== 0) {
	console.error(
		`check-bundles: ${problems.length} 项不一致 —— 修好后重跑安装脚本`,
	);
	process.exit(1);
}
console.log(
	`check-bundles: ${PRESETS.length} 个预设的运行时行全部就位（裸包名 + exports 声明）`,
);
