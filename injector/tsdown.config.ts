import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-super-injector'

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // 见 hostBundle 处说明：类型必须真产出，否则 package.json 的
  // `exports["./client"].types` 是悬空引用。entry 名 `client` → `lib/client.d.mts`。
  dts: true,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    // 同 hostBundle：函数形态，否则类型 chunk 会被命名成 client.js。
    entryFileNames: (chunk) => (chunk.name.endsWith('.d') ? '[name].d.mts' : '[name].js'),
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

// 宿主自包含打包：把 @deepseek-ai/dsh-tools / schemastery 等运行时依赖打进
// lib/index.js（node: 内置模块保持 external）。官方装配（dsh plugin add <目录>）
// 对目录外 link: 依赖不装 peers，Node 从包真实路径解析不到
// '@deepseek-ai/dsh-tools' 会整棵 plugin tree 加载失败（issue #1）——
// 打包后 lib 零外部依赖，任何装配路径都能加载。
const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  // ⚠️ dts 必须开：package.json 的 `types` 指向 `./lib/index.d.mts`，而本包**唯一**
  // 会跑的构建就是 tsdown（`scripts/prepare.mjs` 走 tsdown；`scripts/build.sh`
  // 那条 tsc 路径要 DSH_CHECKOUT，不在任何安装路径上）。关掉 dts 时那两条类型
  // 声明立刻变成悬空引用——守卫 `package-metadata-paths` 会如实报出。
  // 实测 tsdown 的类型输出是**扁平**的、扩展名 `.d.mts`：entry 名 `index` →
  // `lib/index.d.mts`、`client` → `lib/client.d.mts`，不是 `lib/types/**`。
  // 改 entry 名或改 package.json 的声明路径时，两处必须同步。
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    alwaysBundle: (id: string) => !id.startsWith('node:'),
  },
  outputOptions: {
    // ⚠️ 必须是**函数**，不能是固定字符串 'index.js'。固定字符串会把类型 chunk
    // 也命名成 index.js（实测产出 `lib/index.ts`，一个既不是可执行 JS 也不是声明
    // 文件的中间物），因为 tsdown 的命名逻辑是
    // `chunk.name.endsWith('.d') ? dtsExtension : jsExtension`
    // （`tsdown/dist/build-D_enfyvD.mjs:459-463`）——固定 entryFileNames 直接短路它。
    // 函数形态下：JS chunk → index.js，类型 chunk → index.d.mts。
    entryFileNames: (chunk) => (chunk.name.endsWith('.d') ? '[name].d.mts' : '[name].js'),
  },
}

export default [hostBundle, clientBundle] satisfies UserConfig[]
