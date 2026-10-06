import type {
  PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

const STARTED = "2026-10-02T12:00:00.000Z";

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (
  login: string,
  createdAt: string,
  body = "Please rename this.",
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

const noRemarks: ReadonlyArray<PullRequestComment> = [];
/** The base branch was read and requires no checks. */
const NONE_REQUIRED: ReadonlyArray<string> = [];

describe("evaluatePullRequestWatch", () => {
  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks, NONE_REQUIRED);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(
      evaluatePullRequestWatch(lint.next, first, noRemarks, NONE_REQUIRED).changes,
      [],
    );

    // A different job failing later is news of its own.
    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks, NONE_REQUIRED);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    // A rerun leaves the list while it runs, so failing again is reported again.
    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks, NONE_REQUIRED);
    assert.equal(
      evaluatePullRequestWatch(rerun.next, second, noRemarks, NONE_REQUIRED).changes.length,
      1,
    );

    // A push reports its failures, even ones that failed between two passes.
    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(
      evaluatePullRequestWatch(test.next, pushed, noRemarks, NONE_REQUIRED).changes.length,
      1,
    );
  });

  it("reports passed once the required checks pass, whatever the others do", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const green = detail({
      checks: [required("test", "success"), required("lint", "success"), check("bot", "pending")],
    });
    const passed = evaluatePullRequestWatch(watch(), green, noRemarks, ["test", "lint"]);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(
      evaluatePullRequestWatch(passed.next, green, noRemarks, ["test", "lint"]).changes,
      [],
    );

    // Where the branch requires none, every check has to pass.
    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(
      evaluatePullRequestWatch(watch(), plain, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("test", "success")] }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(
      evaluatePullRequestWatch(first.next, both, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  describe("with the base branch's required check list", () => {
    const MIGRATIONS = "Validate migrations on PostgreSQL 18";
    const AGGREGATE = "Lint, type-check, test and build";
    const requiredChecks = [MIGRATIONS, AGGREGATE];
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const complete = detail({
      checks: [
        required(MIGRATIONS, "success"),
        required(AGGREGATE, "success"),
        check("Affected workspace checks", "success"),
        check("CodeRabbit", "pending"),
      ],
    });

    it("waits for a required check no run has created yet, then reports passed once", () => {
      // The aggregate job starts only after the workspace jobs, so it is absent at first.
      const early = evaluatePullRequestWatch(
        watch(),
        detail({
          checks: [required(MIGRATIONS, "success"), check("Affected workspace checks", "pending")],
        }),
        noRemarks,
        requiredChecks,
      );
      assert.deepEqual(early.changes, []);
      assert.isFalse(early.next.passed);

      const ready = evaluatePullRequestWatch(early.next, complete, noRemarks, requiredChecks);
      assert.deepEqual(ready.changes, [{ kind: "checks-passed", count: 2, required: true }]);
      assert.deepEqual(
        evaluatePullRequestWatch(ready.next, complete, noRemarks, requiredChecks).changes,
        [],
      );
    });

    it("never reports passed while the list is unknown, and keeps what it already told", () => {
      const unknown = evaluatePullRequestWatch(watch(), complete, noRemarks, "unknown");
      assert.deepEqual(unknown.changes, []);
      assert.isFalse(unknown.next.passed);

      const ready = evaluatePullRequestWatch(unknown.next, complete, noRemarks, requiredChecks);
      assert.equal(ready.changes.length, 1);
      // An unreadable list later neither takes the news back nor tells it twice.
      const blind = evaluatePullRequestWatch(ready.next, complete, noRemarks, "unknown");
      assert.deepEqual(blind.changes, []);
      assert.isTrue(blind.next.passed);
      assert.deepEqual(
        evaluatePullRequestWatch(blind.next, complete, noRemarks, requiredChecks).changes,
        [],
      );

      // A host that cannot list required checks never reports passed from the flags it has, but
      // comments and conflicts still wake.
      const conflicted = evaluatePullRequestWatch(
        watch(),
        detail({ ...complete, mergeability: "conflicting" }),
        [remark("reviewer", "2026-10-02T12:06:00Z")],
        "unknown",
      );
      assert.deepEqual(
        conflicted.changes.map((change) => change.kind),
        ["remarks", "conflicting"],
      );

      // A failure is still news while the list cannot be read.
      const failed = detail({
        checks: [required(MIGRATIONS, "success"), required(AGGREGATE, "failure")],
      });
      assert.deepEqual(evaluatePullRequestWatch(watch(), failed, noRemarks, "unknown").changes, [
        { kind: "checks-failed", failed: [required(AGGREGATE, "failure")] },
      ]);
    });

    it("reports a failure, then passed once its rerun recovers, and again for a new head", () => {
      const failing = detail({
        checks: [required(MIGRATIONS, "success"), required(AGGREGATE, "failure")],
      });
      const failed = evaluatePullRequestWatch(watch(), failing, noRemarks, requiredChecks);
      assert.equal(failed.changes[0]?.kind, "checks-failed");

      const rerun = detail({
        checks: [required(MIGRATIONS, "success"), required(AGGREGATE, "pending")],
      });
      const running = evaluatePullRequestWatch(failed.next, rerun, noRemarks, requiredChecks);
      assert.deepEqual(running.changes, []);
      const recovered = evaluatePullRequestWatch(running.next, complete, noRemarks, requiredChecks);
      assert.deepEqual(recovered.changes, [{ kind: "checks-passed", count: 2, required: true }]);

      const pushed = detail({ ...complete, headSha: "bbbbbbbbbb" });
      assert.deepEqual(
        evaluatePullRequestWatch(recovered.next, pushed, noRemarks, requiredChecks).changes,
        [{ kind: "checks-passed", count: 2, required: true }],
      );
    });

    it("matches a required job GitHub qualifies with its workflow", () => {
      const qualified = detail({
        checks: [check(`CI / ${AGGREGATE}`, "success"), check(MIGRATIONS, "success")],
      });
      assert.deepEqual(
        evaluatePullRequestWatch(watch(), qualified, noRemarks, requiredChecks).changes,
        [{ kind: "checks-passed", count: 2, required: true }],
      );
    });

    it("needs every check to pass where the branch requires none", () => {
      const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
      const waiting = evaluatePullRequestWatch(watch(), plain, noRemarks, []);
      assert.deepEqual(waiting.changes, []);
      const green = detail({ checks: [check("test", "success"), check("bot", "success")] });
      assert.deepEqual(evaluatePullRequestWatch(waiting.next, green, noRemarks, []).changes, [
        { kind: "checks-passed", count: 2, required: false },
      ]);
    });
  });

  it("does not wake a watch saved before passed checks were recorded", () => {
    const green = detail({ checks: [{ ...check("test", "success"), required: true }] });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true });
    const saved = evaluatePullRequestWatch(told, green, noRemarks, ["test"]);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later pass when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluatePullRequestWatch(watch(), detail(), null, NONE_REQUIRED);
    assert.deepEqual(partial.changes, []);
    assert.equal(
      evaluatePullRequestWatch(partial.next, detail(), comments, NONE_REQUIRED).changes[0]?.kind,
      "remarks",
    );
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluatePullRequestWatch(watch(), detail(), [first], NONE_REQUIRED);
    const again = evaluatePullRequestWatch(reported.next, detail(), [first, late], NONE_REQUIRED);
    assert.deepEqual(again.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(again.next.remarkIds, [first.id, "late"]);
  });

  it("reports edits after the watermark once and counts them toward the wake limit", () => {
    const old = remark("greptile[bot]", "2026-10-02T11:00:00Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarkIds: [old.id],
      wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
    });
    assert.deepEqual(
      evaluatePullRequestWatch(watching, detail(), [old], NONE_REQUIRED).changes,
      [],
    );
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluatePullRequestWatch(watching, detail(), [edited], NONE_REQUIRED);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.deepEqual(report.next.remarkIds, [old.id]);
    assert.isTrue(report.exhausted);
    assert.deepEqual(
      evaluatePullRequestWatch(report.next, detail(), [edited], NONE_REQUIRED).changes,
      [],
    );
    const late = { ...edited, id: "late" };
    assert.deepEqual(
      evaluatePullRequestWatch(report.next, detail(), [edited, late], NONE_REQUIRED).changes,
      [{ kind: "remarks", remarks: [late] }],
    );
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluatePullRequestWatch(watch(), failed, noRemarks, NONE_REQUIRED);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluatePullRequestWatch(
      reported.next,
      detail({ checks: [] }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(unreadable.next, failed, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  it("wakes for the pull request's author when the agent is someone else", () => {
    const contributor = detail({ author: { login: "contributor", name: null, avatarUrl: null } });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(
      evaluatePullRequestWatch(watch(), contributor, [reply], NONE_REQUIRED).changes,
      [{ kind: "remarks", remarks: [reply] }],
    );
    // Without a viewer, the author is taken to be the agent.
    const noViewer = detail({ viewer: undefined, author: contributor.author });
    assert.deepEqual(
      evaluatePullRequestWatch(watch(), noViewer, [reply], NONE_REQUIRED).changes,
      [],
    );
  });

  it("reports remarks from others once and never the agent's own", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    const report = evaluatePullRequestWatch(watch(), detail(), comments, NONE_REQUIRED);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(
      evaluatePullRequestWatch(report.next, detail(), comments, NONE_REQUIRED).changes,
      [],
    );
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks, NONE_REQUIRED);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    // GitHub answers "unknown" while it recomputes after a push; that is not a resolution.
    const recomputing = evaluatePullRequestWatch(
      first.next,
      detail({ mergeability: "unknown" }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(recomputing.next, conflicting, noRemarks, NONE_REQUIRED).changes,
      [],
    );
    const clean = evaluatePullRequestWatch(first.next, detail(), noRemarks, NONE_REQUIRED);
    assert.deepEqual(
      evaluatePullRequestWatch(clean.next, conflicting, noRemarks, NONE_REQUIRED).changes,
      [{ kind: "conflicting" }],
    );
  });

  it("does not spend the comment wake limit on check results", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(
      tired,
      detail({ checks: [check("lint", "failure")] }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("stops after the wake limit unless the head moves", () => {
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.isTrue(evaluatePullRequestWatch(tired, detail(), comments, NONE_REQUIRED).exhausted);
    const pushed = evaluatePullRequestWatch(
      tired,
      detail({ headSha: "cccccccccc" }),
      comments,
      NONE_REQUIRED,
    );
    assert.isFalse(pushed.exhausted);
    assert.equal(pushed.next.wakes, 1);
  });
});

describe("pullRequestWatchMessage", () => {
  it("tells the agent what changed and marks failures for the timeline", () => {
    const report = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("lint", "failure")] }),
      [remark("reviewer", "2026-10-02T12:10:00Z", "<!-- bot -->Needs a test.")],
      NONE_REQUIRED,
    );
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: report.next.headSha,
      report,
    });
    assert.include(message.text, "- Checks failed on aaaaaaa:\n  - lint https://ci.example/lint");
    assert.include(message.text, '  - reviewer on src/index.ts: "Needs a test."');
    assert.include(message.text, "unwatch_pull_request");
    assert.deepEqual(message.notification, {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: "#12: checks failed, new comments",
    });
  });
});
