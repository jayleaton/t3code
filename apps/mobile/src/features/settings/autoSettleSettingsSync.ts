import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type AutoSettleSettings = Pick<
  ServerSettings,
  "sidebarAutoSettleAfterDays" | "autoSettleFinishedChildrenAfterHours"
>;

interface AutoSettleSyncTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null;
  readonly label: string;
  readonly settings: AutoSettleSettings | null;
}

export function planAutoSettleSettingsSync(
  reference: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId | null;
    readonly settings: AutoSettleSettings;
  },
  targets: readonly AutoSettleSyncTarget[],
  // Child auto-settle is environment-wide and unknown to older servers, so callers
  // include it only outside project scope and when every target supports it.
  { includeFinishedChildren = false }: { readonly includeFinishedChildren?: boolean } = {},
) {
  const patch: Partial<AutoSettleSettings> = {
    sidebarAutoSettleAfterDays: reference.settings.sidebarAutoSettleAfterDays,
    ...(includeFinishedChildren
      ? {
          autoSettleFinishedChildrenAfterHours:
            reference.settings.autoSettleFinishedChildrenAfterHours,
        }
      : {}),
  };
  const mismatches = targets.filter(
    (target) =>
      (target.environmentId !== reference.environmentId ||
        target.projectId !== reference.projectId) &&
      target.settings !== null &&
      (target.settings.sidebarAutoSettleAfterDays !== patch.sidebarAutoSettleAfterDays ||
        (includeFinishedChildren &&
          target.settings.autoSettleFinishedChildrenAfterHours !==
            patch.autoSettleFinishedChildrenAfterHours)),
  );
  return { patch, mismatches };
}
