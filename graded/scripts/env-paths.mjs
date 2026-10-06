/**
 * env-paths — 端到端脚本共用的环境路径推导（唯一实现）。
 *
 * 为什么有这个东西：此前的 e2e / 修复脚本里写死了字面占位符
 * （`PATH_TO_NPM_GLOBAL` / `PATH_TO_PLUGIN` / `PATH_TO_DSH_HOME`），
 * 脚本在 import 阶段就因模块找不到而崩溃，或把占位符当成真实工作目录。
 * 本模块把这些值改成**从环境推导**，并在推导不出时给出可执行的修复指引
 * ——「一碰就碎」变成「明确报错」。
 *
 * 推导优先级（每一项都可用显式环境变量覆盖）：
 *   npm 全局目录   DSH_NPM_GLOBAL      → 从 dsh 解析路径反推 → npx/execPath 反推
 *   插件目录       DSH_GRADED_PLUGIN_DIR（默认 = 本文件上两级，即 graded/ 自身）
 *   DSH 主目录     DSH_HOME            → ~/.dsh
 *
 * @module env-paths
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** graded/ 插件根目录（scripts/ 的上一级）——不依赖任何环境变量。 */
export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 报错并退出：缺少必要环境值时给出**可执行**的修复指引，而不是抛一个裸栈。
 *
 * @param {string} what 缺的是什么（人类可读）。
 * @param {string[]} hints 修复建议。
 * @returns {never}
 */
function fail(what, hints) {
  console.error(`\n[env-paths] 无法推导${what}。`)
  for (const h of hints) console.error(`  · ${h}`)
  process.exit(2)
}

/**
 * 定位 DSH 安装根（`.../node_modules/@deepseek-ai/dsh`）。
 *
 * 依次尝试：`DSH_HARNESS_ROOT` 环境变量 → node 模块解析 → npm 全局目录反推。
 *
 * @returns {string | undefined} 安装根绝对路径；找不到返回 undefined。
 */
function findHarnessRoot() {
  const fromEnv = process.env.DSH_HARNESS_ROOT
  if (fromEnv && existsSync(join(fromEnv, 'package.json'))) return resolve(fromEnv)

  // 判据一：从脚本所在包向上解析（npx / 本地安装场景）。
  try {
    const pkgJson = require.resolve('@deepseek-ai/dsh/package.json', { paths: [PLUGIN_DIR, process.cwd()] })
    return dirname(pkgJson)
  } catch {
    /* 继续下一条判据 */
  }

  // 判据二：从 npm 全局目录反推（`npm i -g @deepseek-ai/dsh` 场景）。
  const globalDir = npmGlobalDir()
  if (globalDir) {
    const candidate = join(globalDir, 'node_modules', '@deepseek-ai', 'dsh')
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * 推导 npm 全局目录（全局 `node_modules` 的父目录）。
 *
 * 三条判据按可靠性排序，每条都要求**该目录下真的存在 `@deepseek-ai/dsh`**
 * ——只检查 `node_modules` 存在是不够的：node 自身的安装目录
 * （如 `C:\Program Files\nodejs`）也有 node_modules，会把我们带偏。
 *
 * 1. `DSH_NPM_GLOBAL` 环境变量（显式指定最权威）。
 * 2. `npm root -g` 的父目录（本机 npm 自己说了算）。
 * 3. 从 `process.execPath` 反推。
 *
 * @returns {string | undefined}
 */
function npmGlobalDir() {
  if (process.env.DSH_NPM_GLOBAL) {
    const explicit = process.env.DSH_NPM_GLOBAL
    if (hasHarnessUnder(explicit)) return explicit
    return undefined
  }

  // 判据二：问 npm 自己。
  //
  // Windows 上 npm 是 .cmd 批处理，Node 的 spawn 不能直接执行它
  // （`npm.cmd` 无 shell → EINVAL，`npm` 无 shell → ENOENT，实测本机 Node 24）。
  // 唯一可行路径是 shell:true，它会触发 DEP0190 提醒参数按拼接传递。
  // 这里的命令与参数都是**写死的常量**（'npm.cmd' / ['root','-g']），没有任何
  // 外部输入进入命令行，因此该提醒描述的风险在本处不成立。
  try {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const rootG = execFileSync(npmBin, ['root', '-g'], { encoding: 'utf8', shell: true }).trim()
    const globalDir = dirname(rootG)
    if (hasHarnessUnder(globalDir)) return globalDir
  } catch {
    /* npm 不可用则继续下一条判据 */
  }

  // 判据三：从 node 可执行文件位置反推（<global>/node_modules/... 形态）。
  try {
    const exec = realpathSync(process.execPath)
    const parts = exec.split(sep)
    const nm = parts.lastIndexOf('node_modules')
    if (nm > 0) {
      const candidate = parts.slice(0, nm).join(sep)
      if (candidate && hasHarnessUnder(candidate)) return candidate
    }
  } catch {
    /* 放弃反推 */
  }
  return undefined
}

/**
 * 该目录下的 `node_modules/@deepseek-ai/dsh` 是否真实存在。
 *
 * @param {string} globalDir 候选 npm 全局目录。
 * @returns {boolean}
 */
function hasHarnessUnder(globalDir) {
  return existsSync(join(globalDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

/** npm 全局目录；推导不出时给指引并退出。 */
export function requireNpmGlobal() {
  const dir = process.env.DSH_NPM_GLOBAL || npmGlobalDir()
  if (dir && existsSync(join(dir, 'node_modules'))) return dir
  fail('npm 全局目录', [
    '设 DSH_NPM_GLOBAL=<npm 全局目录>（`npm root -g` 的上一级）后重跑。',
    `当前 node 可执行文件：${process.execPath}`,
  ])
}

/** DSH 安装根（`.../node_modules/@deepseek-ai/dsh`）。 */
export function requireHarnessRoot() {
  const root = findHarnessRoot()
  if (root) return root
  fail('DSH 安装根（@deepseek-ai/dsh）', [
    '设 DSH_HARNESS_ROOT=<.../node_modules/@deepseek-ai/dsh> 后重跑。',
    '或先 `npx @deepseek-ai/dsh --version` 确认已安装。',
  ])
}

/**
 * DSH 主目录（profile / sessions / graded-state 的根）。
 *
 * 优先 `DSH_HOME`，否则 `~/.dsh`。
 */
export function requireDshHome() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return resolve(home)
}

/**
 * 解析 DSH 自带 `ws` 包（e2e 脚本的 WebSocket 客户端）。
 *
 * ws 是 dsh 的传递依赖，不在本插件的 dependencies 里 —— 只能从安装树解析。
 * 返回可直接 `import()` 的 file:// URL。
 *
 * @returns {string} file:// URL 字符串。
 */
export function wsModuleUrl() {
  const harness = requireHarnessRoot()
  const entry = join(harness, 'node_modules', 'ws', 'index.js')
  if (!existsSync(entry)) {
    fail('dsh 自带的 ws 包', [
      `未找到 ${entry}`,
      'DSH 的安装结构可能已变化；确认 dsh 版本或设 DSH_HARNESS_ROOT 指向正确安装。',
    ])
  }
  const url = `file:///${entry.split(sep).join('/').replace(/^\//, '')}`
  return url
}

/** 汇总摘要（脚本启动时可打印，便于复现问题）。 */
export function describe() {
  return {
    pluginDir: PLUGIN_DIR,
    dshHome: requireDshHome(),
    harnessRoot: findHarnessRoot() ?? '(未找到)',
    npmGlobal: npmGlobalDir() ?? '(未找到)',
  }
}
