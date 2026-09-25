#!/usr/bin/env bash
# The fork's release gate. The nightly release runs it before packaging and every
# PR into the release branch runs it too, so a change that would break the nightly
# is caught before it merges. Add fork feature tests here rather than in either workflow.
set -euo pipefail

NODE_ENV=test vp test run \
  apps/web/src/components/agents \
  packages/client-runtime/src/gateway \
  packages/mcp-gateway/src \
  apps/server/src/mcp/toolkits/workspace \
  apps/server/src/scheduledTasks \
  apps/server/src/clients \
  scripts/build-desktop-artifact.test.ts
NODE_ENV=test vp test run \
  apps/server/src/persistence/Migrations/050_ProjectionThreadProfileSnapshot.test.ts \
  apps/server/src/persistence/Migrations/050_ProjectionThreadPullRequests.test.ts \
  apps/server/src/persistence/Migrations/051_ProjectionThreadMessageContext.test.ts \
  apps/server/src/persistence/Migrations/054_ProjectionThreadTitleState.test.ts \
  apps/server/src/persistence/Migrations/055_PullRequestFilesViewed.test.ts \
  apps/server/src/persistence/Migrations/057_ProjectionThreadsAutoSettleDisabledAt.test.ts
NODE_ENV=test vp test run \
  apps/desktop/src/app/SharedSafeStorage.test.ts \
  apps/desktop/src/app/LegacyTokenStorage.test.ts \
  apps/desktop/src/app/DesktopClerk.test.ts \
  apps/desktop/src/app/DesktopConnectionCatalogStore.test.ts
vp run --filter @t3tools/web --filter @t3tools/desktop --filter @t3tools/client-runtime \
  --filter @t3tools/mcp-gateway --filter @t3tools/contracts --filter t3 typecheck
