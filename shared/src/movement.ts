import { MOVE_SPEED, PLAYER_RADIUS } from './constants.js';
import type { MapDef, Rect, Vec } from './types.js';

const inRect = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Is a single point on walkable floor (rooms/corridors) and outside props? */
export function pointWalkable(map: MapDef, x: number, y: number): boolean {
  let floor = false;
  for (const r of map.rooms) if (inRect(r, x, y)) { floor = true; break; }
  if (!floor) for (const c of map.corridors) if (inRect(c, x, y)) { floor = true; break; }
  if (!floor) return false;
  for (const o of map.obstacles) if (inRect(o, x, y)) return false;
  return true;
}

/** Does a player body (centre + 4 diagonal and 4 axis probes) fit at this position? */
export function bodyFits(map: MapDef, x: number, y: number, r = PLAYER_RADIUS): boolean {
  const d = r * 0.72;
  return (
    pointWalkable(map, x, y) &&
    pointWalkable(map, x + r, y) && pointWalkable(map, x - r, y) &&
    pointWalkable(map, x, y + r) && pointWalkable(map, x, y - r) &&
    pointWalkable(map, x + d, y + d) && pointWalkable(map, x - d, y + d) &&
    pointWalkable(map, x + d, y - d) && pointWalkable(map, x - d, y - d)
  );
}

export function roomAt(map: MapDef, x: number, y: number): string | null {
  for (const r of map.rooms) if (inRect(r, x, y)) return r.id;
  return null;
}

const inAny = (rs: Rect[], x: number, y: number) => rs.some((r) => inRect(r, x, y));

/**
 * Advance a position by an intent vector for dtSec seconds. The same function runs on the
 * server (authoritative) and the client (prediction). `sealed` rects cannot be entered
 * from outside but can always be left.
 */
export function stepMove(map: MapDef, pos: Vec, intent: Vec, dtSec: number, sealed: Rect[] = [], speed = MOVE_SPEED): Vec {
  let ix = intent.x, iy = intent.y;
  const mag = Math.hypot(ix, iy);
  if (mag < 0.01) return pos;
  if (mag > 1) { ix /= mag; iy /= mag; }
  const dist = speed * dtSec;
  const wasSealed = inAny(sealed, pos.x, pos.y);
  const stuck = !bodyFits(map, pos.x, pos.y);
  const ok = (x: number, y: number) => (stuck || bodyFits(map, x, y)) && (wasSealed || !inAny(sealed, x, y));
  const nx = pos.x + ix * dist, ny = pos.y + iy * dist;
  if (ok(nx, ny)) return { x: nx, y: ny };
  if (ok(nx, pos.y)) return { x: nx, y: pos.y };
  if (ok(pos.x, ny)) return { x: pos.x, y: ny };
  return pos;
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
