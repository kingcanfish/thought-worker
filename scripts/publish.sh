#!/bin/sh
# 构建端镜像的入口（Dockerfile.publisher）：和 .github/workflows/build.yml 的步骤一致，先迁移再构建部署
set -eu

# 和 CI 一样从 wrangler.toml 读 D1 数据库 ID；R2 和 D1 在同一个 Cloudflare 账号下
export D1_DATABASE_ID="${D1_DATABASE_ID:-$(sed -n 's/^database_id *= *"\(.*\)"/\1/p' wrangler.toml)}"
export R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}"

npx wrangler d1 migrations apply thought-worker --remote
exec npx tsx src/build/main.ts
