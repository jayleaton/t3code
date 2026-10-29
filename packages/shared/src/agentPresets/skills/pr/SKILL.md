---
name: pr
description: "Write or update a PR body with a small visual summary, actual before/after evidence, and merge risk; open PRs as stacked drafts and mark them ready only to merge, to keep CI runs to a minimum."
license: MIT
metadata:
  intended-agents: "Cook, Pastry, Cook (OpenSource)"
  upstream:
    author: Matt Pocock
    url: "https://github.com/mattpocock/skills/blob/4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d/skills/engineering/pr/SKILL.md"
    commit: "4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d"
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: "https://github.com/humanlayer/skills/blob/ca7c8088db69e315a8b2deea43820270457f8f3c/plugins/show-me/skills/show-me/SKILL.md"
    commit: "ca7c8088db69e315a8b2deea43820270457f8f3c"
---

# PR body

For Cook, Pastry, and Cook (OpenSource) when authoring a PR description. Write around the final change so a reader can understand the problem, resulting behavior, proof, and risk without the chat history.

## Scope and precedence

Read the actual diff, relevant behavior, recorded checks, and applicable repository PR template before drafting. Use `GLOSSARY.md` when present; otherwise use the user's and repository's domain language.

Explicit user formatting takes precedence, followed by the repository template, then the default below. Preserve required template headings, fields, and checklists. Fit Summary, Evidence, and Merge Danger into the corresponding fields rather than adding competing structure. If an explicit format excludes visuals or these headings, honor it and convey the same information where allowed.

This skill authors the body; it does not independently authorize creating, publishing, reviewing, or merging a PR. Captain owns merge for Captain-managed work. Standalone merge requires the user's authorization. Launch a reviewer only on the user's explicit review request; writing a PR body does not trigger review.

## Default body

Skip preambles and keep prose brief. Replace every placeholder with observed facts or an explicit evidence limitation.

```markdown
## Summary

<small visual showing the final change, with a brief explanation if needed>

## Evidence

- **Before:** <actual baseline screenshot, output, or failing test result>
  **After:** <actual changed screenshot, output, or passing test result>

## Merge Danger

**Door:** <one-way or two-way>

<brief reason and rollback constraint, when useful>

**Blast Radius:** <one-word scope label>

<concrete affected consumers, behavior, or operational consequences>
```

## Summary

Choose the smallest view that explains the change. Keep a visual beside the short text it supports and include only the calls, files, states, props, and boundaries that matter.

- Logic or algorithm: pseudocode or a state/control-flow diff.
- Runtime control flow: a call tree.
- UI structure: a component tree with relevant state and ownership boundaries.
- File responsibility or broad refactor: a shallow file tree.
- Interactions or data flow: a small Mermaid diagram.
- Change within an existing shape: a `diff` sketch of components, files, calls, or state.
- Mostly new code or order-sensitive ownership: a compact whole block when omitted context would mislead.

Use one visual by default; add another only when it answers a different material question. Illustrative sketches explain the inspected implementation; they are not execution evidence.

## Evidence

Show an actual before/after comparison for the same relevant scenario. For visual changes, use screenshots when the environment permits. For executable behavior, identify the exact command/test, environment or revision, and observed result. Link accessible artifacts or quote concise output; local artifact paths alone are not accessible evidence to GitHub readers.

A before result may come from a recorded baseline or a safely reproduced run of the old behavior. Do not invent screenshots, output, failures, passes, or numerical improvements. If baseline evidence is unavailable, say **Before: not captured** and describe that limitation. If after verification is blocked, state the specific blocker and what was actually checked; keep verification marked incomplete. A new feature's baseline may be an observed absence rather than a failing test.

Pseudocode can explain a test's scenario, but label it illustrative and pair it with actual run results. Compilation alone does not prove runtime behavior. Distinguish executed checks from proposed checks and report relevant failures or untested paths.

## Merge Danger

**Door:** use **two-way** when rollback cheaply restores behavior and state; use **one-way** for destructive actions or decisions that rollback cannot undo. Assess deployed effects such as persisted data, schema compatibility, external side effects, and irreversible migrations. Explain mixed or uncertain cases instead of assuming a code revert reverses everything.

**Blast Radius:** choose a one-word scope label, such as `component`, `service`, `consumers`, or `platform`. Add a brief factual explanation of affected surfaces and plausible consequences, including layout/mobile behavior, API consumers, shared state, or deployment boundaries when relevant. A scope label is not proof of safety.

## Draft and stacked PRs

CI minutes are the cost to minimise. Open a PR only when the user asks for one, and then follow these rules unless the user or the repository says otherwise.

- **Open every PR as a draft** (`gh pr create --draft`). If the repository's CI skips drafts, a draft avoids those CI runs; inspect the actual workflow before assuming that behavior.
- **Stack dependent work.** Split it into one concern per PR. Base each layer on the branch below it (`gh pr create --draft --base <lower-branch>`), not on `main`. Register every layer with `link_pull_request`, and in each body name the PR it sits on.
- **The local checks are the gate while drafted.** Before each push, run the repository's own checks for that layer: format, lint, type-check, and the tests you touched. A draft is not an excuse to push red work.
- **Batch pushes.** Commit locally and push when a layer is coherent, not after every edit. On a ready PR, each push starts a full run. Where newer runs cancel older ones, they still bill for the time already spent.
- **Run CI once per landing, not once per layer.** When the stack is ready to merge, mark ready only the PR that merges next: the bottom one (`gh pr ready <n>`). That triggers its required checks. After it merges, rebase the next layer onto `main` (with squash merges: `git rebase --onto origin/main <old-lower-branch>`), retarget it to `main`, and mark it ready. When layers are small and closely related, ask the merge owner whether to land them together. One option is to merge the upper layers down into the bottom PR and close them, which gives one ready PR and one CI run. Never merge a PR whose required checks have not run on its final commit.
- **Respect repository gates.** Before merge, remove any repository-specific labels that skip CI and mark the PR ready, so the required checks run and pass.
- **Keep the stack fresh.** When a lower layer changes, rebase the layers above it before marking any of them ready. Keep the stack short: two to four layers, with no layer waiting long.

## Completion

Re-read the finished body against the final diff and actual artifacts. Confirm the visual reflects the final implementation, evidence is traceable and limitations visible, risk matches deployment effects, and user/template requirements are met. Retain unchecked checklist items when their conditions are unmet. Remove stale scope and unresolved placeholders.

## Attribution and license

Adapted from Matt Pocock's `pr` at the pinned commit in frontmatter. The upstream credits Dex Horthy / HumanLayer's `show-me`; that credit is retained. T3 adaptation adds format precedence, evidence integrity, delivery ownership, and draft-and-stack CI discipline. Source links are provenance, not runtime dependencies. Retain these notices when redistributing this adaptation; they are not part of the generated PR body.

### Matt Pocock — MIT notice

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

### HumanLayer — MIT notice

MIT License

Copyright (c) 2026 HumanLayer

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
