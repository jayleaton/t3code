---
name: diagnose
description: Investigate nontrivial bugs and performance regressions using reproducible
  evidence, targeted instrumentation, and a verified fix.
---




# Diagnose

Start with the reported behavior, relevant domain docs, recent changes, and the narrowest useful feedback loop. Prefer a failing test, request replay, CLI fixture, browser interaction, or small harness that exercises the real failure. For intermittent bugs, measure reproduction frequency and record the conditions.

Form falsifiable hypotheses and choose the next observation that distinguishes them. Scale this to the problem; an obvious defect does not need five hypotheses or a mandatory phase ceremony. If reproduction is unavailable, continue useful source/trace analysis, distinguish hypotheses from confirmed causes, and state what evidence is missing.

Use a debugger or targeted logs for behavior and a profiler/baseline for performance. Give temporary logs a unique searchable prefix and clear purpose; stringify safe browser-console objects when copyability helps. Preserve the project's structured server logging conventions and avoid sensitive payloads. Remove temporary instrumentation when done.

A regression check should exercise the real call pattern and fail before the fix when feasible. Do not add a shallow test just to mirror implementation. Re-run the original scenario and the relevant project checks; report limits if the failure could not be reproduced.

For a human-only reproduction, the optional [HITL loop](scripts/hitl-loop.template.sh) structures captured feedback. For specialized rendering or queue diagnostics, use the project's own tools and documentation. Recommend architecture work only when concrete coupling or testability issues remain after diagnosis.
