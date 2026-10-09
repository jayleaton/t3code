import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

/** Inset of the card from the canvas edges; the find bar shares it to line up. */
export const THREAD_DETAILS_CARD_GAP = 12;
export const THREAD_DETAILS_CARD_DEFAULT_WIDTH = 280;

export function resolveThreadDetailsCardMaximumWidth(
  containerWidth: number,
  lane: { padding: number; minChatWidth: number },
) {
  return Math.max(
    THREAD_DETAILS_CARD_DEFAULT_WIDTH,
    Math.min(
      560,
      containerWidth -
        THREAD_DETAILS_CARD_GAP -
        DETAILS_CARD_CLEARANCE -
        lane.padding -
        lane.minChatWidth,
    ),
  );
}

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

/**
 * The card pins to the top right while a readable chat lane fits beside it.
 * The chat canvas decides whether chat moves over to make room.
 */
export function resolveThreadDetailsCardLayout({
  container,
  lane,
  frame,
  overlapsDetailsCard = false,
  preferredWidth = THREAD_DETAILS_CARD_DEFAULT_WIDTH,
  topInset = 0,
}: {
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  preferredWidth?: number;
  /** Space taken above the card, such as the open find bar. */
  topInset?: number;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  const width = Math.max(
    THREAD_DETAILS_CARD_DEFAULT_WIDTH,
    Math.min(preferredWidth, resolveThreadDetailsCardMaximumWidth(container.width, lane)),
  );
  const x = container.width - width - gap;
  if (x - DETAILS_CARD_CLEARANCE - lane.padding < lane.minChatWidth) return null;
  const y = gap + topInset;
  // Resizing consumes the height above the player. Dragging first tries to
  // clear the full card and folds it only when there is no readable placement.
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - gap, frame.y - y - gap)
      : container.height - y - gap;
  if (height < 160) return null;
  return {
    x,
    width,
    y,
    height,
  } as const;
}
