const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateReleaseHealth } = require("./fork-release-health.cjs");

const mainHead = { sha: "5c5b58ae80c4aa", committedAt: "2026-10-24T06:00:00Z" };
const nightly = (publishedAt) => ({ tagName: `v0.1.0-nightly.${publishedAt}`, publishedAt });
const run = (conclusion, n) => ({
  conclusion,
  createdAt: `2026-10-2${n}T00:00:00Z`,
  url: `run/${n}`,
});

test("healthy when the newest nightly is within 36 h of main and runs pass", () => {
  assert.deepEqual(
    evaluateReleaseHealth({
      mainHead,
      nightlies: [nightly("2026-10-21T00:00:00Z"), nightly("2026-10-23T00:00:00Z")],
      runs: { Release: [run("failure", 3), run("success", 2)] },
    }),
    [],
  );
});

test("fails when nothing merged in the last 36 h has shipped (the 10-22 to 10-24 stall)", () => {
  const problems = evaluateReleaseHealth({
    mainHead,
    nightlies: [nightly("2026-10-22T14:53:32Z")],
    runs: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is 39 h older than main 5c5b58ae80/);
});

test("fails on two failures in a row, ignoring skipped and cancelled runs", () => {
  const problems = evaluateReleaseHealth({
    mainHead,
    nightlies: [nightly("2026-10-24T05:00:00Z")],
    runs: {
      Sync: [run("failure", 4), run("skipped", 3), run("cancelled", 2), run("failure", 1)],
      Release: [run("failure", 4), run("success", 3), run("failure", 2)],
    },
  });
  assert.deepEqual(problems, ["Sync failed twice in a row: run/4 and run/1."]);
});

test("fails when no nightly has ever been published", () => {
  assert.deepEqual(evaluateReleaseHealth({ mainHead, nightlies: [], runs: {} }), [
    "No nightly release has been published.",
  ]);
});
