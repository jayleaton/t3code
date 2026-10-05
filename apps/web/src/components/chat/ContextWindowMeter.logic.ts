import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/**
 * Whether the footer should hold the meter's slot before a snapshot exists.
 *
 * The snapshot comes from thread activities, which load after the shell.
 * Reserving the slot while the detail loads, for a started thread, keeps the
 * attach button still until the meter mounts. Once the detail is in, a
 * missing snapshot means there is no usage to show and nothing is reserved.
 *
 * The meter renders from stored activities whatever the provider's state, so
 * only a provider known not to stream usage skips the reservation. An unknown
 * provider (catalog still loading, or the thread's provider disabled) reserves.
 */
export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  /** `null` while the thread's provider is not in the catalog. */
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
