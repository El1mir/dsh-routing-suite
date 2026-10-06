#!/usr/bin/env bash
# dsh-routing-suite 一键安装（Linux/macOS；镜像 install.ps1）：
# 装配注入器 + 装配三个 router preset（bundle 协议）+ 自检 + 提示重启。
# 注入器装配：优先源码构建（npm prepare），失败自动回退官方 Release tgz（SUPER_INJECTOR_VERSION 覆盖版本，默认 0.3.3）。
#
# 注：旧的 `$DSH_HOME/.agent-presets/<id>/` 目录协议在当前 harness 已不存在
# （安装树里搜不到任何 `.agent-presets` 读取；`dsh-agent-preset-registry` 只接受
# 通过 Cordis composition 注册的 preset）。三个预设已迁移为 **bundle 包**：
# 每个 `preset/<name>/bundle/` 是一个独立 npm 包，package.json 里声明
# `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，由官方
# `dsh plugin --profile <p> add` 装配，装配后写进 profile 的 `dsh.profile.bundles`。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_NAME="${DSH_PROFILE:-web}"

# DSH_HOME 优先：部署环境 homedir 可能与 DSH_HOME 不一致，不能只靠 $HOME
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
INJECTOR_DIR="$ROOT/injector"
PRESET_NAMES=("router-standard" "router-react" "router-spec")

# 输出着色（非终端自动禁用）
if [ -t 1 ]; then
  C_CYAN=$'\e[36m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_RESET=$'\e[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi

info() { printf '%s=== %s ===%s\n' "$C_CYAN" "$1" "$C_RESET"; }
ok()   { printf '%s✓ %s%s\n'  "$C_GREEN" "$1" "$C_RESET"; }
warn() { printf '%s! %s%s\n'  "$C_YELLOW" "$1" "$C_RESET"; }
err()  { printf '%s✗ %s%s\n'  "$C_RED" "$1" "$C_RESET"; }

# 官方装配通道：dsh 不在 PATH 时回退 npx
dsh_plugin_add() {
  if command -v dsh >/dev/null 2>&1; then
    dsh plugin --profile "$PROFILE_NAME" add "$1"
  else
    npx '@deepseek-ai/dsh' plugin --profile "$PROFILE_NAME" add "$1"
  fi
}

info '[0/4] 环境预检'
if ! command -v node >/dev/null 2>&1; then
  err '未找到 node（构建注入器 lib/ 需要 Node.js，请先安装或加载 nvm）'
fi
if ! command -v dsh >/dev/null 2>&1; then
  warn 'dsh 不在 PATH——装配时将回退到 npx @deepseek-ai/dsh'
fi
echo "仓库目录 : $ROOT"
echo "DSH_HOME  : $DSH_HOME"
echo "profile   : $PROFILE_NAME"

info '[1/4] 装配注入器'

# 装配包目录：源码构建成功 = 仓库内 injector/；否则 = Release tgz 解压目录
PKG_DIR="$INJECTOR_DIR"

if [ ! -f "$PKG_DIR/lib/index.js" ]; then
  warn 'injector/lib 缺失——尝试 npm install 触发 prepare 钩子构建（首次需网络拉取 tsdown）...'
  ( cd "$INJECTOR_DIR" && npm install --no-audit --no-fund ) || warn 'npm install 失败（可忽略）'
  if [ -f "$INJECTOR_DIR/lib/index.js" ]; then
    ok 'injector/lib 构建完成'
  else
    # 源码构建依赖私有 @deepseek-ai peer 包（package-lock 锁定），公共 npm registry 404 → 回退官方 Release tgz
    SPI_VERSION="${SUPER_INJECTOR_VERSION:-0.3.3}"
    SPI_DIST_DIR="$DSH_HOME/external/dsh-super-injector"
    SPI_TGZ="https://github.com/yjh051108/dsh-super-injector/releases/download/v${SPI_VERSION}/dsh-external-dsh-super-injector-${SPI_VERSION}.tgz"
    if [ ! -f "$SPI_DIST_DIR/lib/index.js" ]; then
      warn "源码构建不可行——自动下载官方预构建 Release v${SPI_VERSION} ..."
      warn "  $SPI_TGZ"
      mkdir -p "$SPI_DIST_DIR"
      if curl -fL --retry 2 -m 120 "$SPI_TGZ" | tar -xzf - -C "$SPI_DIST_DIR" --strip-components=1; then
        if [ -f "$SPI_DIST_DIR/lib/index.js" ]; then
          ok "Release 包就位：$SPI_DIST_DIR"
        else
          err "Release 包解压后缺少 lib/index.js——包内容异常，请到 https://github.com/yjh051108/dsh-super-injector/releases 核对"
        fi
      else
        err "Release 下载/解压失败（$SPI_TGZ）——请手动下载 tgz 后重跑本脚本，或改用："
        warn '  B. github: 装配（prepare 钩子自动构建）：dsh plugin --profile web add github:yjh051108/dsh-super-injector'
        warn '  C. 有 DSH 源码 checkout 时：DSH_CHECKOUT=<checkout> bash scripts/build.sh 后再重跑本脚本'
      fi
    else
      ok "检测到已就位的 Release 包：$SPI_DIST_DIR"
    fi
    if [ -f "$SPI_DIST_DIR/lib/index.js" ]; then
      PKG_DIR="$SPI_DIST_DIR"
    fi
  fi
fi

PATCH_FILE="$DSH_HOME/profiles/$PROFILE_NAME/cordis.patch.yml"
manual_fallback=0
if [ -f "$PATCH_FILE" ] && grep -q 'dsh-super-injector' "$PATCH_FILE"; then
  warn 'cordis.patch.yml 已含 dsh-super-injector——跳过装配（防 duplicate loader entry id）'
elif [ -f "$PKG_DIR/lib/index.js" ]; then
  if dsh_plugin_add "$PKG_DIR"; then
    ok '注入器已装配（重启后由 bundles 接管）'
  else
    err 'dsh plugin add 失败（见上方输出）——可改用手动装配（见下）'
    manual_fallback=1
  fi
  if [ "$manual_fallback" -eq 1 ]; then
    warn '手动装配回退（免 pnpm，与官方装配二选一）：'
    warn "  1) mkdir -p '$DSH_HOME/profiles/$PROFILE_NAME/node_modules/@dsh-external'"
    warn "  2) ln -sfn '$PKG_DIR' '$DSH_HOME/profiles/$PROFILE_NAME/node_modules/@dsh-external/dsh-super-injector'"
    warn "  3) 在 '$PATCH_FILE' 的顶层数组里追加："
    warn '     - insert:'
    warn '         - id: dsh-super-injector'
    warn "           name: '@dsh-external/dsh-super-injector'"
    warn '           config: {}'
    warn '  4) 重启 DSH'
  fi
else
  warn '未获得可装配的注入器包（lib 缺失）——请按上方提示处理后再重跑本脚本'
fi

info '[2/4] 装配 router presets（bundle 协议）'
for name in "${PRESET_NAMES[@]}"; do
  bundle="$ROOT/preset/$name/bundle"
  if [ ! -f "$bundle/package.json" ]; then
    err "仓库缺少预设 bundle：$bundle（跳过）"
    continue
  fi
  # bundle 目录本身就是一个 npm 包：package.json 声明 dsh.bundle.patch，
  # cordis.patch.yml 里是声明行 + 裸包名运行时行（经 exports 映射解析）。
  if dsh_plugin_add "$bundle"; then
    ok "预设 bundle 已装配：$name"
  else
    err "预设 bundle 装配失败：$name（见上方输出）"
  fi
done

info '[3/4] 自检装配结果'
MANIFEST="$DSH_HOME/profiles/$PROFILE_NAME/package.json"
failed=0
if [ ! -f "$MANIFEST" ]; then
  err "找不到 profile 清单 $MANIFEST"
  failed=1
else
  for name in "${PRESET_NAMES[@]}"; do
    pkg="@dsh-external/dsh-preset-$name"
    if ! grep -q "\"$pkg\"" "$MANIFEST"; then
      err "$name 未出现在 profile 清单（$pkg）——DSH 不会加载它"
      failed=1
      continue
    fi
    ok "$name -> $pkg 已声明"
  done
fi
# 模块行能否被 loader 解析，由共享校验脚本判定（单一实现，口径与
# preset/scripts/sync-preset.cjs 的 verify 一致）：运行时行必须是裸包名
# 子路径、已在 bundle/package.json 的 exports 里声明、且文件就位。
# 相对行 ./x.mjs 嵌在 config.plugins[] 里永不被锚定，会按 profile 目录
# 解析而报 ERR_MODULE_NOT_FOUND —— 三个预设曾全部因此静默不加载。
checker="$ROOT/preset/scripts/check-bundles.cjs"
if [ -f "$checker" ]; then
  if node "$checker" "$ROOT"; then
    :
  else
    failed=1
  fi
else
  err "找不到共享校验脚本 $checker"
  failed=1
fi
if [ "$failed" -ne 0 ]; then
  err '装配自检失败——请检查上方 FAIL 项后重跑本脚本'
fi

info '[4/4] 完成'
echo '1. 重启 DSH（web 服务）—— bundle 的 patch 只在 DSH 启动时读取，装完必须重启'
echo '2. GUI 新建会话 → 选择 Router Standard / Router React / Router Spec'
echo '3. 发任务：生成任务自动 react，维护任务自动 spec，模糊任务进 weak 内路由'
echo '4. AI 自优化工具：dev_router_status / dev_router_mode / dev_mode_subagent'
