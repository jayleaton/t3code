---
name: retro
description: "Conduct a requested coding-session retrospective and rank evidence-backed improvements to the agent environment."
license: MIT
metadata:
  intended-agents: "Captain"
  upstream:
    author: Matt Pocock
    url: "https://github.com/mattpocock/skills/blob/4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d/skills/engineering/retro/SKILL.md"
    commit: "4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d"
  writing-guidance:
    url: "https://github.com/mattpocock/skills/blob/4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d/skills/productivity/writing-for-agents/SKILL.md"
---

# Retrospective

For Captain when the user requests a retrospective, or the user explicitly assigns one through Captain. Suggest improvements to the coding agent's environment that would improve future runs. Default to the current session if no session is specified.

This is a retrospective, not a PR review or a new implementation assignment. Deliver recommendations only: do not automatically change code, instructions, skills, hooks, CI, permissions, or agent settings, and do not create PRs or launch new review rounds. Implementation requires a separate explicit assignment. Do not assume every task receives agent review; evaluate review behavior only when review was explicitly requested and occurred. Captain owns communication and merge for managed work.

## Read the evidence

Read primary sources for the selected session: available conversation/thread history, task handoff and ledger, tool calls and results, actual diffs, test/build output, CI results, logs, and any explicitly requested review records. Use bounded searches of local session logs when needed. Keep the session and repository scope explicit.

Inspect the repository's real check commands and wiring before recommending checks: build-tool scripts, linter/type configuration, tests, hooks, and CI workflows. Read relevant steering files and existing docs before proposing more documentation. Do not presume that `AGENTS.md`, `CLAUDE.md`, `CODING_STANDARDS.md`, a hook, or a particular tool exists.

Tie each candidate to a cited session event or inspected artifact. Separate observation from inference and mark unavailable sources; missing access is not evidence that a check or policy is absent. Avoid secrets and irrelevant transcript dumps. If the sources do not support findings, report the evidence limits or that no supported improvement was found.

## Compare prior retrospectives and changes

Before making recommendations in every retrospective, search the relevant project and Projects `.t3/captain/` reports, incident ledger and linked follow-up work for the same failure or proposed remedy. Use a bounded search by obligation, symptom and affected workflow; follow relevant report links rather than reading unrelated history. Record the search scope and explicitly state when no relevant prior report is found or evidence is unavailable.

For each relevant prior recommendation, cite its report and inspect the actual resulting artifact, commit, skill/config revision or live setting. Classify it as proposed, implemented, verified effective, ineffective, reverted/superseded or unknown; a report saying “done” does not establish implementation or effectiveness. Compare the prior intent, actual change, observed outcome and current finding. Distinguish a missing implementation, a fix that did not reach an existing thread, an ineffective fix and a genuinely new failure.

Include a concise prior-results comparison in the report. Explain what is new and the smallest justified next action. If the remedy is already proposed or pending, link and reconcile the existing work instead of proposing or launching it again. If an implemented remedy failed, identify the demonstrated gap and propose a narrow correction to that remedy before adding another rule or mechanism. Preserve effective changes and explicit holds. Flag conflicting or superseded recommendations and name the authoritative destination to amend; do not automatically revert or replace anything.

For any proposed change, explain how it differs from prior changes and how validation will detect the recurrence and unintended effects on previously working behavior. If there is no new evidence or useful change, say so and stop. This comparison authorizes investigation and recommendations only; implementation and additional retrospectives retain their existing authorization requirements.

## Improvement categories

Investigate categories supported by the session or inspected environment; do not force a finding in every category.

- **Navigation:** repeated searches, hard-to-find ownership, hidden dependencies, or time spent locating information. Recommend a short pointer naming the material and exactly when to read it; point to existing references first.
- **Automated checks:** errors that linting, typing, tests, or filesystem checks could catch. An existing command that is unwired or silently broken is the finding, rather than a reason to reinvent it. Confirmed absence of any pre-commit/CI guardrail running the relevant lint/typecheck/test commands is itself an improvement candidate, with severity grounded in consequences.
- **Coding standards:** classify the failure first. Mechanical patterns (banned APIs, fixed syntax, import shapes, file locations) require a recommended deterministic check in the cheapest suitable existing linter, hook, or CI mechanism. Propose its failing fixture and passing case; do not substitute a prose reminder. Reserve prose standards for judgement calls such as cross-file consistency or matching surrounding style. Apply standards to the agents that need them under the actual workflow, including implementers; reviewer guidance is relevant only when review occurred by explicit request.
- **Global AGENTS.md:** inspect oversized global or repository steering for mechanical rules that belong in checks and judgement guidance that belongs in scoped standards/docs. Keep always-loaded instructions sparse and routing-focused; retain necessary behavioral constraints.
- **Tool economy:** identify costly, repetitive, or verbose calls from actual tool traces. Recommend narrower queries, batching independent reads, bounded output, or a focused CLI/MCP improvement. Quantify savings only where the record supports them.
- **No-ops:** identify steering text that repeats a default, duplicates an authoritative source, or no longer applies. Explain the behavior it fails to change. Treat an uncertain default as a hypothesis needing a scoped experiment, not proof that a rule can be deleted.
- **Information access:** identify crucial unavailable evidence. Recommend scoped access such as retained dev-server logs or read-only service queries. State the missing information and decision it would enable; permissions or account access remain separate authorized work.

## Self-contained writing guidance

Use this guidance when recommending instructions, documentation, or skills; no external writing skill is required.

- State the behavior and intended reader. Place guidance in the narrowest surface that reaches that reader at the right time.
- A context pointer names its destination and the condition for loading it. Give each distinct trigger one clear phrase; a skill description is also a pointer.
- Keep essential actions and checkable completion criteria together. Group definitions, rules, and caveats by concept. Disclose substantial conditional detail behind a pointer only when the destination exists and is reachable.
- Keep each meaning in one authoritative location. Existing configuration is the source for cheap command/configuration lookups; document unwritten conventions and costly discoveries rather than stale copies of those lookups.
- Account for always-loaded context cost and the human's cost of remembering where references live. Prefer existing docs; split large standards into focused references with useful pointers.
- State the desired behavior directly. Remove duplicate, stale, irrelevant, or behavior-neutral instructions only with supporting evidence. Keep hard guardrails where required.
- Recommend concrete completion criteria and a validation method that distinguishes the failure from success. Keep the recommendation bounded to the observed problem.

## Present recommendations

Honor the user's requested format. Otherwise, present supported recommendations in descending severity, with a short scope/evidence-limit note as needed. Use:

- **Critical:** observed exposure or irreversible harm requiring urgent attention.
- **High:** demonstrated recurring or substantial correctness/reliability failure.
- **Medium:** meaningful repeated friction or a confirmed guardrail gap with bounded consequences.
- **Low:** local convenience, clarity, or context-cost improvement.

For each recommendation include **severity and category**, **observation with source**, **impact**, **proposed environment change and destination**, and **how to validate it**. Make uncertainty explicit; do not manufacture frequency, elapsed time, or impact. List recommendations as proposals, not as completed changes. Combine candidates with the same cause and avoid unrelated policy expansion.

For a mechanical error, the validation proposal must specify a deterministic failing example and a passing example, plus where the check would run. An existing broken check needs a repair/wiring proposal and a way to confirm it executes and catches the failure. Recommendations for judgement guidance need a concrete example of the decision they clarify.

## Completion

Verify the prior-results comparison and reconcile duplicate, pending or conflicting recommendations before completion. Check every recommendation against the cited source, existing environment, severity definition, and proposed validation. Confirm all seven categories were considered where evidence permits, evidence gaps are visible, there is no required external skill dependency, and the output does not claim unperformed changes or initiate implementation/review. Finish with the ranked recommendations; further work waits for assignment.

## Attribution and license

Adapted from Matt Pocock's `retro` and relevant `writing-for-agents` guidance at commit `4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d`. T3 adaptation replaces the external Skill-tool dependency with inline guidance, makes review conditional on explicit request, and limits the workflow to evidence-backed recommendations. Source links are provenance, not runtime dependencies. Retain this notice when redistributing this adaptation.

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
