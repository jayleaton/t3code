import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "Menlo";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-4 py-2.5";
/** Each Home row is its own bordered card, so it is clear where one ends. */
export const THREAD_LIST_V2_ROW_FRAME_CLASS_NAME =
  "mx-3 my-1 overflow-hidden rounded-2xl border border-border bg-card";
export const THREAD_LIST_V2_PENDING_ROW_FRAME_CLASS_NAME = THREAD_LIST_V2_ROW_FRAME_CLASS_NAME;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(_branch: string) {
  return "New thread on branch";
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const style: ViewStyle | undefined = sidebarPane
    ? {
        backgroundColor: selected ? selectedBackgroundColor : theme["--color-drawer"],
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme["--color-border"],
      }
    : undefined;
  const swipeContainerStyle: ViewStyle | undefined = sidebarPane
    ? { borderRadius: 12, overflow: "hidden" }
    : undefined;

  return {
    className: sidebarPane ? undefined : "bg-screen",
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
    tertiaryIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-tertiary",
    style,
    cardStyle: sidebarPane ? { ...style, paddingHorizontal: 12, paddingVertical: 10 } : undefined,
    swipeContainerStyle,
    swipeBackgroundColor: theme[sidebarPane ? "--color-drawer" : "--color-screen"],
    // Provider badges blend into the surface beneath them.
    providerIconSurfaceColor: sidebarPane
      ? selected
        ? selectedBackgroundColor
        : theme["--color-drawer"]
      : theme["--color-screen"],
  };
}
