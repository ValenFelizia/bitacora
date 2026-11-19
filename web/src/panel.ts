import { PANEL_WIDTH } from "../../server/src/contracts";

/** The works column, and the narrowest conversation that stays readable beside the panel. */
const WORKS_COLUMN = 220;
const MIN_CONVERSATION = 420;
/** Below this width the panel is a drawer and keeps its own size. */
export const DESKTOP_MIN = 960;

/** How wide the panel can be in a window this wide. */
export function panelBounds(viewport: number) {
  const room = viewport - WORKS_COLUMN - MIN_CONVERSATION;
  return { min: PANEL_WIDTH.min, max: Math.max(PANEL_WIDTH.min, Math.min(PANEL_WIDTH.max, room)) };
}

export function clampPanel(width: number, viewport: number) {
  const { min, max } = panelBounds(viewport);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * Width after a key on the divider, or undefined for a key it ignores. The
 * panel sits on the right, so the left arrow makes it wider.
 */
export function panelKey(key: string, width: number, viewport: number, large = false) {
  const step = large ? 64 : 16;
  const { min, max } = panelBounds(viewport);
  switch (key) {
    case "ArrowLeft":
      return clampPanel(width + step, viewport);
    case "ArrowRight":
      return clampPanel(width - step, viewport);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return undefined;
  }
}
