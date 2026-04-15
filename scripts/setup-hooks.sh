#!/usr/bin/env bash
# 安装 ContextAtlas git hooks
# 用法: bash scripts/setup-hooks.sh
# 或通过 pnpm install 自动执行（package.json prepare 脚本）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SOURCE_DIR="$REPO_ROOT/scripts/git-hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "⚠️ .git/hooks 不存在，跳过 hook 安装"
  exit 0
fi

for hook in "$SOURCE_DIR"/*; do
  hook_name=$(basename "$hook")
  target="$HOOKS_DIR/$hook_name"

  cp "$hook" "$target"
  chmod +x "$target"
  echo "✅ 已安装 git hook: $hook_name"
done
