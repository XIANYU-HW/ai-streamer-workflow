#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装包含 npm 的 Node.js 22.12 或更新版本：https://nodejs.org/en/download'
  exit 1
fi
node scripts/setup.mjs "$@"
