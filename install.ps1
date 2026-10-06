# dsh-routing-suite 一键安装（Windows PowerShell）
# 步骤：1) 装配注入器  2) 装配 router-standard / router-react / router-spec 预设（bundle 协议）
#       3) 自检装配结果  4) 提示重启
#
# 注：旧的 `$DSH_HOME/.agent-presets/<id>/` 目录协议在当前 harness 已不存在
# （安装树里搜不到任何 `.agent-presets` 读取；`dsh-agent-preset-registry` 只接受
# 通过 Cordis composition 注册的 preset）。三个预设已迁移为 **bundle 包**：
# 每个 `preset/<name>/bundle/` 是一个独立 npm 包，package.json 里声明
# `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，由官方
# `dsh plugin --profile <p> add` 装配，装配后写进 profile 的 `dsh.profile.bundles`。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }

# dsh CLI 可能不在 PATH（用 npx @deepseek-ai/dsh web 启动的场景）
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
function Invoke-DshPluginAdd([string]$pkgDir) {
  if ($dshCmd) {
    & dsh plugin --profile $profileName add $pkgDir 2>&1 | Out-Host
  } else {
    & npx '@deepseek-ai/dsh' plugin --profile $profileName add $pkgDir 2>&1 | Out-Host
  }
}

Write-Host '=== [1/4] 装配注入器 ===' -ForegroundColor Cyan
$injector = Join-Path $root 'injector'
if (-not (Test-Path (Join-Path $injector 'lib\index.js'))) {
  # 全新 clone 没有 lib/（构建产物不入库）。github: 装配（方式 B）会在安装时由
  # prepare 钩子自动构建；本地目录装配若构建不可行，请改用 Release tgz（方式 A）。
  Write-Host 'injector/lib 缺失——尝试 npm install 触发 prepare 钩子构建（若私有 peer 拉取失败会自动跳过）...' -ForegroundColor Yellow
  Push-Location $injector
  try {
    & npm install --no-audit --no-fund 2>&1 | Out-Host
  } catch {
    Write-Host 'npm install 失败（可忽略）' -ForegroundColor DarkGray
  } finally {
    Pop-Location
  }
  if (-not (Test-Path (Join-Path $injector 'lib\index.js'))) {
    Write-Host '自动构建不可行——注入器请改用以下方式装配：' -ForegroundColor Yellow
    Write-Host '  A. Release tgz（预构建，推荐）：https://github.com/yjh051108/dsh-super-injector/releases' -ForegroundColor Yellow
    Write-Host '  B. github: 装配（prepare 钩子自动构建）：dsh plugin --profile web add github:yjh051108/dsh-super-injector' -ForegroundColor Yellow
  } else {
    Write-Host 'injector/lib 构建完成' -ForegroundColor Green
  }
}
if (Test-Path (Join-Path $injector 'lib\index.js')) {
  Invoke-DshPluginAdd $injector
  Write-Host '注入器已装配（重启后由 bundles 接管）' -ForegroundColor Green
}

Write-Host '=== [2/4] 装配 router presets（bundle 协议） ===' -ForegroundColor Cyan
$presetRoot = Join-Path $root 'preset'
$presets = @('router-standard', 'router-react', 'router-spec')
foreach ($name in $presets) {
  $bundle = Join-Path $presetRoot "$name\bundle"
  if (-not (Test-Path (Join-Path $bundle 'package.json'))) {
    Write-Host "仓库缺少预设 bundle：$bundle（跳过）" -ForegroundColor Red
    continue
  }
  # bundle 目录本身就是一个 npm 包：package.json 声明 dsh.bundle.patch，
  # cordis.patch.yml 里是声明行 + 裸包名运行时行（经 exports 映射解析）。
  Invoke-DshPluginAdd $bundle
  Write-Host "预设 bundle 已装配：$name" -ForegroundColor Green
}

Write-Host '=== [3/4] 自检装配结果 ===' -ForegroundColor Cyan
$manifestPath = Join-Path $env:USERPROFILE ".dsh\profiles\$profileName\package.json"
if (-not (Test-Path $manifestPath)) {
  Write-Host "FAIL: 找不到 profile 清单 $manifestPath" -ForegroundColor Red
} else {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $bundles = @($manifest.dsh.profile.bundles)
  $deps = @($manifest.dependencies.PSObject.Properties.Name)
  $expect = @{
    'router-standard' = '@dsh-external/dsh-preset-router-standard'
    'router-react'    = '@dsh-external/dsh-preset-router-react'
    'router-spec'     = '@dsh-external/dsh-preset-router-spec'
  }
  $failed = 0
  foreach ($name in $presets) {
    $pkg = $expect[$name]
    if ($bundles -notcontains $pkg) {
      Write-Host "FAIL: $name 未出现在 dsh.profile.bundles（$pkg）——DSH 不会加载它" -ForegroundColor Red
      $failed = 1
      continue
    }
    if ($deps -notcontains $pkg) {
      Write-Host "FAIL: $name 未出现在 dependencies（$pkg）" -ForegroundColor Red
      $failed = 1
      continue
    }
    Write-Host "OK: $name -> $pkg 已声明为 bundle" -ForegroundColor Green
  }
  # 模块行能否被 loader 解析，由共享校验脚本判定（单一实现，口径与
  # preset/scripts/sync-preset.cjs 的 verify 一致）：运行时行必须是裸包名
  # 子路径、已在 bundle/package.json 的 exports 里声明、且文件就位。
  # 相对行 ./x.mjs 嵌在 config.plugins[] 里永不被锚定，会按 profile 目录
  # 解析而报 ERR_MODULE_NOT_FOUND —— 三个预设曾全部因此静默不加载。
  $checker = Join-Path $repoRoot 'preset\scripts\check-bundles.cjs'
  if (Test-Path $checker) {
    node $checker $repoRoot
    if ($LASTEXITCODE -ne 0) { $failed = 1 }
  } else {
    Write-Host "FAIL: 找不到共享校验脚本 $checker" -ForegroundColor Red
    $failed = 1
  }
  if ($failed -ne 0) {
    Write-Host '装配自检失败——请检查上方 FAIL 项后重跑本脚本' -ForegroundColor Red
  }
}

Write-Host '=== [4/4] 完成 ===' -ForegroundColor Cyan
Write-Host '1. 重启 DSH（web 服务）—— bundle 的 patch 只在 DSH 启动时读取，装完必须重启' -ForegroundColor Yellow
Write-Host '2. GUI 新建会话 → 选择 Router Standard / Router React / Router Spec' -ForegroundColor Yellow
Write-Host '3. 发任务：生成任务自动 react，维护任务自动 spec，模糊任务进 weak 内路由' -ForegroundColor Yellow
Write-Host '4. AI 自优化工具：dev_router_status / dev_router_mode / dev_mode_subagent' -ForegroundColor Yellow
