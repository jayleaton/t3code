---
name: captain-event-loop
description: "Captain's event loop for named children on T3 builds since nightly 20261016: arm one listener per running child, sweep every child on every wake, take the next step from the pipeline, and never end a turn with a child unwatched. Read at the start of every Captain turn that launches, messages or checks a child."
---

# Captain event loop

## Why this exists

Since T3 nightly 20261016.322001 (runtime commit `7089486ba`, "stop automatic child-to-parent messages"), a named child never wakes its parent. That covers `t3_thread_launch`, `create_threads` and `delegate_task` with a `profileId`, and it includes run ends, `stopped`, `interrupted`, task DONE/INPUT updates and check-backs. The only events that start an idle Captain turn are:

1. a message from the user;
2. a **profile-less `delegate_task` helper reaching any terminal state** (completed, failed, or interrupted). These arrive as one batched message, "Delegated tasks … reached terminal states", and are queued if Captain is mid-turn;
3. `watch_pull_request` events.

So every running child needs its own listener: a profile-less helper that blocks on that child with `t3_thread_wait` and finishes when the child's run ends. Its completion is the wake. This is not polling: there is one blocking call per child run, no timer and no message between chats.

## Launching and messaging children

- Start named children with `t3_thread_launch` (or `create_threads`). Each gets an automatic task, so it shows in the one-call sweep. For Cleaner, launch one new child per review round with `t3_thread_launch`. Avoid `delegate_task` with a `profileId`: it creates no task, so it is invisible to the sweep and its completion is silently disposed.
- Send follow-ups with `t3_thread_send`, not `t3_send_message`, because `t3_thread_send` returns the new `runId`.
- Every brief ends with: _"When you finish, or whenever you need a decision, end your turn with a short summary. Put any question on the last line as `BLOCKED: <question> (default: <what you would pick>)`. Do not use interactive question tools, and do not message Captain."_ `t3_thread_wait` does not return while a child sits in `waiting_input`; only a finished turn ends the wait. A child that ignores this rule and asks a question while nothing else is running will not wake Captain. The question is caught at the next wake's sweep, which may be the user's next message.

### Children on another machine

`t3_thread_wait`, `t3_thread_send`, `t3_thread_read` and the `t3_task_read` sweep only see threads on this machine. They return `thread_not_found` for a child launched with `t3_create_and_start_thread` on another environment (T3 gap, see bug report). For such a child:

- Record its `environmentId` in PIPELINE.md.
- Message it with `t3_send_message` + `environmentId`.
- Read it with `t3_get_messages` / `t3_get_thread` + `environmentId`.
- Arm the listener as a profile-less helper that calls `t3_get_thread` with `environmentId` every 60 s for at most 60 min. It replies when the latest run is no longer running or the last message has a `BLOCKED:` line.

When the deliverable is a file or artifact on this machine, a background waiter on that file may be used instead. In each sweep, also check every remote child listed in PIPELINE.md this way. This is the one allowed exception to "never poll"; remove it once T3 supports cross-machine waits.

## Arm: one listener per running child run

Arm a listener immediately after any action that starts or resumes a child run: launch, `t3_thread_send`, answering a question, or resume/retry. Never leave two listeners on one child.

```
delegate_task {
  title: "listen <child short name>",
  mode: "async",
  target: { providerInstanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "low" }] },
  clientRequestId: "listen:<childThreadId>:<runId>",
  task: "You are an event listener. Call the t3-code tool t3_thread_wait with threadId \"<childThreadId>\", runId \"<runId>\" and timeoutMs 3600000 (a number, never the string Infinity). If it returns timedOut true, or fails with a connection error such as ECONNRESET, call it again with the same arguments, at most 8 calls in total. Call no other tool: never SendMessage, never message anyone, never read or write files. When a call returns timedOut false, or after the 8th call, or on any other error, reply with one line: threadId, run status, timedOut, or the exact error text."
}
```

Record the listener's `taskId` against the child in the pipeline table. A listener can still end without the run ending (a repeated connection error, or the 8-hour cap), so a wake means "look", not "the child stopped". The sweep decides. Fallback model: `codex` / `gpt-5.6-luna` / `reasoningEffort: low` (also proven). T3 caps one MCP tool call at 65 minutes, so the listener re-waits hourly itself. Captain is not woken unless a wait errors or the 8-hour cap is reached.

## Wake: sweep everything, then act

Treat every turn as a wake, whether it is the user's message or a "Delegated tasks … reached terminal states" message. Then:

1. **Sweep once:** call `t3_task_read` with no `threadId`. It returns every launched child with `status`, `workerRun` (`running`/`idle`/`waiting_input`/…) and `continuationLive`. Prefer the task sweep over listing unrelated threads. Then call `task_status` for each listener or `delegate_task` named in the wake message. Reading the result acknowledges that wake.
2. **Compare with the pipeline table** and handle every child whose state changed, not only the one named in the wake:
   - **idle / completed:** read the child's last 3–5 messages (`t3_get_messages`). If they hold a deliverable, verify it, record it and start the pipeline's next step (next instruction with `t3_thread_send`, the next child, a Cleaner round, or a merge), then re-arm. If the last line is `BLOCKED:`, decide it (see Defaults), reply with `t3_thread_send`, then re-arm.
   - **waiting_input / waiting_approval:** call `t3_get_pending_questions`, then answer with `t3_answer_question` using the default rule. Re-arm only if the child's run ended. Escalate to the user only for decisions on the "ask the user" list.
   - **interrupted / failed / stopped:** read the last messages. Resume once with `t3_thread_send` ("continue from where you stopped; re-check uncommitted work first"), then re-arm. If it stops again with no progress, report it to the user with the evidence.
   - **running with no live listener** (after a reboot, a listener error, or the 8-hour cap): arm one.
   - **running with a live listener:** leave it alone.
3. **End-of-turn invariant** (check before replying): every running child has exactly one live listener; every idle child has its next step started, is waiting on the user for a listed decision, or is done and settled; nothing is waiting on Captain. Only then end the turn. Never sleep, poll, schedule a check or send a "status?" message.

## Pipeline table

Keep the job's table in `.t3/captain/<job>/PIPELINE.md` so it survives context compaction and reboots: child id | role | current step | done means | next step | listener taskId | last state seen. Each wake maps a changed row to "read the last 3–5 messages, then the next step". When an instruction from the user changes the plan, update the table first.

## Defaults instead of blocking on the user

Captain leads. Decide reversible and routine choices yourself: order, naming, which safe migration pattern, splitting PRs, starting a Cleaner round the user already authorised, re-running checks, resuming a stopped child, and merging each PR bottom-up once its review fixes are in, CI is green and the staging deploy is checked. State the choice under "Defaults taken" in the next update to the user. Ask the user, and keep the rest of the pipeline moving meanwhile, only for: production deploys or releases, architecture exceptions (per the repo's CLAUDE.md), product decisions the user has not made, destructive data operations, spending or purchases, and anything outward-facing that the user has not already approved.

## Reboots and T3 updates

A reboot kills every child and listener run. Per the runtime source (restart recovery finalizes interrupted helper subagents and resumes their completion delivery), each killed listener should then deliver a terminal wake, and the sweep shows the children as `interrupted`, so resume them. This is not yet observed live. If no wake arrives, the user's next message is the wake: always sweep first. After any T3 update, recheck the wake semantics in the `delegate_task` and `t3_task_assign` tool descriptions before trusting this skill.

## Cost

A listener costs one small helper turn per child run, plus one more helper step for each hour the child runs past 60 minutes. Token usage varies with context size and provider caching. Do not arm listeners for idle or settled children. Settle finished children promptly.
