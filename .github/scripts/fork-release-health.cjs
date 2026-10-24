// Fails the scheduled release health check when the fork stops shipping: the newest
// nightly is far behind main, or the nightly release or sync keeps failing. A red
// scheduled run is how GitHub tells the owner; nothing else pages anyone.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const MAX_NIGHTLY_LAG_MS = 36 * 60 * 60 * 1000;
const WATCHED_WORKFLOWS = [
  { file: "fork-nightly-release.yml", name: "Fork nightly release" },
  { file: "fork-nightly-sync.yml", name: "Fork nightly sync" },
];
// Skipped and cancelled runs say nothing about whether the workflow works.
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

const hours = (ms) => `${Math.round(ms / (60 * 60 * 1000))} h`;

/**
 * @param {{
 *   mainHead: { sha: string, committedAt: string },
 *   nightlies: Array<{ tagName: string, publishedAt: string }>,
 *   runs: Record<string, Array<{ conclusion: string, createdAt: string, url: string }>>,
 * }} input runs are newest first, per workflow name.
 * @returns {string[]} one message per problem; empty when healthy.
 */
function evaluateReleaseHealth({ mainHead, nightlies, runs }) {
  const problems = [];
  const newest = nightlies.toSorted((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  const headAt = Date.parse(mainHead.committedAt);
  if (newest === undefined) {
    problems.push("No nightly release has been published.");
  } else {
    const lag = headAt - Date.parse(newest.publishedAt);
    if (lag > MAX_NIGHTLY_LAG_MS) {
      problems.push(
        `Newest nightly ${newest.tagName} (${newest.publishedAt}) is ${hours(lag)} older than main ${mainHead.sha.slice(0, 10)} (${mainHead.committedAt}); nothing merged since has shipped.`,
      );
    }
  }

  for (const [name, workflowRuns] of Object.entries(runs)) {
    const decisive = workflowRuns.filter(
      (run) => run.conclusion === "success" || FAILED_CONCLUSIONS.has(run.conclusion),
    );
    const [latest, previous] = decisive;
    if (
      latest !== undefined &&
      previous !== undefined &&
      FAILED_CONCLUSIONS.has(latest.conclusion) &&
      FAILED_CONCLUSIONS.has(previous.conclusion)
    ) {
      problems.push(`${name} failed twice in a row: ${latest.url} and ${previous.url}.`);
    }
  }
  return problems;
}

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.RELEASE_BRANCH || "main";
  const head = gh(["api", `repos/${repo}/commits/${branch}`]);
  const nightlies = gh([
    "release",
    "list",
    "--repo",
    repo,
    "--limit",
    "50",
    "--json",
    "tagName,publishedAt,isDraft",
  ]).filter((release) => !release.isDraft && release.tagName.includes("-nightly."));
  const runs = Object.fromEntries(
    WATCHED_WORKFLOWS.map(({ file, name }) => [
      name,
      gh([
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        file,
        "--branch",
        branch,
        "--status",
        "completed",
        "--limit",
        "30",
        "--json",
        "conclusion,createdAt,url",
      ]),
    ]),
  );

  const problems = evaluateReleaseHealth({
    mainHead: { sha: head.sha, committedAt: head.commit.committer.date },
    nightlies,
    runs,
  });
  const summary =
    problems.length === 0
      ? "Fork release health: OK."
      : ["Fork release health: failing.", "", ...problems.map((problem) => `- ${problem}`)].join(
          "\n",
        );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { evaluateReleaseHealth };
