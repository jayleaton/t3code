import { describe, expect, it } from "vite-plus/test";

import { classifyCommandRisks } from "./commandRisk.ts";

const kinds = (command: string) => classifyCommandRisks(command).map((risk) => risk.kind);

describe("classifyCommandRisks", () => {
  it.each([
    ["rm -rf ./images", ["recursive-delete"]],
    ["sudo rm -R build", ["recursive-delete"]],
    ["rm --recursive dist", ["recursive-delete"]],
    ["bash -lc 'cd app && rm -fr node_modules'", ["recursive-delete"]],
    ["ls *.tmp | xargs rm -rf", ["recursive-delete"]],
    ["find . -name '*.log' -delete", ["recursive-delete"]],
    ["git push --force origin main", ["force-push"]],
    ["git push -f", ["force-push"]],
    ["git push --force-with-lease", ["force-push"]],
    ["git push origin +main", ["force-push"]],
    ["git reset --hard HEAD~3", ["discard-changes"]],
    ["git clean -fdx", ["discard-changes"]],
    ["git checkout -- .", ["discard-changes"]],
    ["git restore src/app.ts", ["discard-changes"]],
    ["git stash drop", ["discard-changes"]],
    ["git branch -D feature", ["delete-branch"]],
    ["npx prisma migrate deploy", ["database"]],
    ['psql -c "DROP TABLE users"', ["database"]],
    ["git reset --hard && rm -rf dist", ["discard-changes", "recursive-delete"]],
  ])("flags %s", (command, expected) => {
    expect(kinds(command)).toEqual(expected);
  });

  it.each([
    "rm file.txt",
    "rm -f build.log",
    "git push origin main",
    "git push --follow-tags",
    "git reset HEAD~1",
    "git restore --staged src/app.ts",
    "git checkout -b feature",
    "git branch -d merged",
    "git clean -n",
    "find . -name '*.ts'",
    "pnpm test",
  ])("leaves %s alone", (command) => {
    expect(kinds(command)).toEqual([]);
  });
});
