---
name: agentic-harness-design
description: Design or evaluate agent orchestration, handoffs, context management,
  and generator/evaluator loops for sustained tasks.
---

# Agent Harness Design

Start with a representative task set, measurable success criteria, permitted side effects, and cost/latency limits. Add orchestration only when a simpler baseline demonstrates a specific failure.

Separate planning, generation, and evaluation when independence helps. A planner defines deliverables and constraints without inventing product scope. The generator implements them; an evaluator checks actual artifacts or behavior and gives reproducible findings. Use browser interaction when the task concerns interaction, not as a universal evaluation requirement.

A handoff should record the current artifact/revision, completed work, unresolved issues, decisions, verification, and next action. Compaction continues a session with summarized context; a reset starts a new one and must reconstruct state. Choose based on observed continuity and failure recovery, not model-name assumptions.

For long work, agree on bounded increments and acceptance criteria. Keep ownership of files/actions clear, make retries and external operations idempotent, and cap iteration/spend. Untrusted tool or document content must not silently change the task contract.

Calibrate evaluators against known good/bad examples and human judgment. Measure false passes and false failures; an adversarial tone alone does not establish quality. Re-run representative tasks when prompts/models change and remove components that no longer help.

This skill designs harnesses; it does not itself authorize spawning agents for an unrelated task.
