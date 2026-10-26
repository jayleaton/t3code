import type { ProviderInteractionMode } from "@t3tools/contracts";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/**
 * Codex cuts the middle out of any `additionalContext` value over 1,000 tokens,
 * which it counts as UTF-8 bytes divided by four. It does this silently, so
 * every value built here has to fit.
 */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

/**
 * Apps may store up to 16 KiB each and a thread can hold any number of them,
 * so only the most recently updated ones that fit this budget go to Codex.
 */
export const CODEX_APP_CONTEXT_MAX_TOTAL_BYTES = 4 * CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;

const TRUNCATION_MARKER = "\n…[truncated]…\n";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const takeUtf8Bytes = (chars: ReadonlyArray<string>, maxBytes: number): Array<string> => {
  const taken: Array<string> = [];
  let bytes = 0;
  for (const char of chars) {
    bytes += utf8Bytes(char);
    if (bytes > maxBytes) break;
    taken.push(char);
  }
  return taken;
};

/**
 * Cuts the middle out ourselves, as Codex would, so a value restored after
 * compaction (which Codex does not truncate) matches what the turn delivered.
 */
const fitCodexContextValue = (text: string): string => {
  if (utf8Bytes(text) <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) return text;
  const chars = Array.from(text);
  const half = Math.floor(
    (CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES - utf8Bytes(TRUNCATION_MARKER)) / 2,
  );
  const head = takeUtf8Bytes(chars, half).join("");
  const tail = takeUtf8Bytes(chars.toReversed(), half).toReversed().join("");
  return `${head}${TRUNCATION_MARKER}${tail}`;
};

/**
 * An app's context is text an MCP server wrote, so it goes in as untrusted
 * context: Codex renders it as quoted user-side input, never as developer
 * instructions. Entries arrive oldest update first.
 */
export function buildCodexAppContext(
  entries: ReadonlyArray<{ readonly key: string; readonly text: string }>,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const kept: Array<readonly [string, V2TurnStartParams__AdditionalContextEntry]> = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    const value = fitCodexContextValue(entry.text);
    bytes += utf8Bytes(value);
    if (bytes > CODEX_APP_CONTEXT_MAX_TOTAL_BYTES) break;
    kept.push([entry.key, { kind: "untrusted", value }]);
  }
  return Object.fromEntries(kept.toReversed());
}

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

The \`t3-code\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, using the exact launcher path returned by \`device_open\`. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Prefer these tools and \`agent-device\` for opening and driving devices. Platform tools such as \`xcrun simctl\` and \`adb\` remain available for anything they do not cover, such as builds, logs, or port forwarding. If \`device_list\` reports a platform as unavailable, say so.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/**
 * Describing `preview_*` or `device_*` tools that aren't in the turn's tool list would be worse
 * than saying nothing: the instructions actively steer the model away from Playwright,
 * agent-browser, and raw simctl/adb, so leaving them in would talk it out of the only automation
 * it still has.
 */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You are in **Plan Mode** until a developer message explicitly ends it. User intent, tone, or imperative language does not change the mode: treat a request to execute as a request to **plan the execution**. Chat your way to a plan that is **decision complete**: detailed enough in intent and implementation that another engineer or agent could implement it right away without making any decisions.

\`update_plan\` is a separate checklist/progress tool. It does not enter or exit Plan Mode, and it returns an error if used in Plan Mode.

## Non-mutating work only

Do non-mutating work that improves the plan: read and search files, configs, schemas, types, manifests, and docs; run static analysis, dry runs, and tests, builds, or checks that write only to caches or build artifacts (for example \`target/\` or \`.cache/\`), never to repo-tracked files.

Do not edit or write files, run formatters or linters that rewrite files, apply patches, migrations, or codegen that change repo-tracked files, or run side-effectful commands that carry out the plan. When in doubt: if it would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## Phases

1. **Ground in the environment.** Resolve discoverable facts by exploring, not asking; silent exploration is encouraged. Do at least one targeted exploration pass before asking anything, unless no local environment is available. You may ask first only about obvious ambiguities or contradictions in the prompt itself, and only when exploring could not resolve them. Never ask what the repo or system can answer (for example, "where is this struct?"). If several plausible candidates remain, present them (paths, service names) and recommend one.
2. **Intent.** Keep asking until you can state the goal and success criteria, audience, what is in and out of scope, constraints, current state, and key preferences or tradeoffs. If a high-impact ambiguity remains, ask instead of guessing.
3. **Implementation.** Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs, schemas, I/O), data flow, edge cases and failure modes, testing and acceptance criteria, rollout and monitoring, and migrations or compatibility constraints.

## Asking questions

Strongly prefer the \`request_user_input\` tool, with only meaningful options and no filler. Ask directly without it only when an unavoidable, important question cannot be expressed as reasonable multiple-choice options. Ask as many questions as needed, but each must materially change the plan, confirm or lock an assumption, or choose between meaningful tradeoffs, and must not be answerable by non-mutating exploration. Ask about preferences and tradeoffs early, with 2-4 mutually exclusive options and a recommended default; if unanswered, proceed with the recommendation and record it as an assumption in the final plan.

## Final plan

Present the plan only when it is decision complete, wrapped in a \`<proposed_plan>\` block so the client can render it:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

<proposed_plan>
plan content
</proposed_plan>

The plan is plan-only, human and agent digestible, and concise by default. Include a clear title, a brief summary, important changes to public APIs, interfaces, or types, test cases and scenarios, and explicit assumptions and defaults. Prefer 3-5 short sections (usually Summary, Key Changes, Test Plan, Assumptions) with short bullets grouped by subsystem or behavior, not file-by-file; name files only to disambiguate, usually no more than 3. Leave out repeated invariants, unaffected behavior, and schema, validation, or wire-shape policy the request does not establish; prefer the minimum interface and behavior changes. Expand only if the user asks.

Do not ask "should I proceed?": the user can switch out of Plan mode to implement, or stay to refine. Produce at most one \`<proposed_plan>\` block per turn. A revised plan must be a complete replacement. If the user rejects the plan without enough information for a replacement, address the concern and keep planning without a block. If a follow-up neither requires changes nor calls the plan into question (for example, a clarifying question), answer it before the block, then reproduce the prior \`<proposed_plan>\` unchanged.
</collaboration_mode>`;

const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

Use the \`request_user_input\` tool only when it is listed in the available tools for this turn.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`;

export function buildCodexDeveloperInstructions(interactionMode: ProviderInteractionMode): string {
  return interactionMode === "plan"
    ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
    : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS;
}

/**
 * This must stay out of the collaboration mode: when the model catalog ships
 * its own text for a mode, as newer models do, Codex uses that text and drops
 * the client's `developer_instructions` entirely.
 *
 * Model and effort stay out of the text because they already go to Codex as
 * turn settings; naming them here would change developer context on every
 * effort toggle.
 */
export function buildCodexAdditionalContext(
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Separate keys keep each value under Codex's per-entry cap. Codex emits
  // entries in key order, so the numbering preserves the authored order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex" }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
