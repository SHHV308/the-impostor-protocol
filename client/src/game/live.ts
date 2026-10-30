/** Mutable per-frame state shared between the canvas, input handling and the HUD. */
export const live = {
  me: { x: 0, y: 0, init: false },
  intent: { x: 0, y: 0 },
  followPid: null as string | null,
};
