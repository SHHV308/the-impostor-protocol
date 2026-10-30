import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, MAPS, PLAYER_RADIUS, bodyFits, stepMove, roomAt } from '@impostor/shared';

function reachable(env: (typeof ENVIRONMENTS)[number]) {
  const map = MAPS[env];
  const step = 10;
  const key = (x: number, y: number) => `${x},${y}`;
  const sx = Math.round(map.spawn.x / step) * step, sy = Math.round(map.spawn.y / step) * step;
  const seen = new Set([key(sx, sy)]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const nx = x + dx, ny = y + dy;
      if (!seen.has(key(nx, ny)) && bodyFits(map, nx, ny)) { seen.add(key(nx, ny)); q.push([nx, ny]); }
    }
  }
  return { map, seen, step };
}

describe.each(ENVIRONMENTS)('map %s', (env) => {
  const { map, seen, step } = reachable(env);

  it('has 12 missions covering all four categories and 4 sabotages', () => {
    expect(map.missions).toHaveLength(12);
    expect(new Set(map.missions.map((m) => m.category))).toEqual(new Set(['logic', 'repair', 'hacking', 'investigation']));
    expect(map.sabotages).toHaveLength(4);
    expect(map.sabotages.some((s) => s.kind === 'critical')).toBe(true);
  });

  it('lets a player stand next to and reach every station from the spawn point', () => {
    for (const s of map.stations) {
      const near = [...seen].some((k) => { const [x, y] = k.split(',').map(Number); return Math.hypot(x! - s.x, y! - s.y) < 60; });
      expect(near, `${s.id} unreachable`).toBe(true);
    }
    void step;
  });

  it('keeps spawn ring positions on the floor', () => {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      expect(bodyFits(map, map.spawn.x + Math.cos(a) * 36, map.spawn.y + Math.sin(a) * 36)).toBe(true);
    }
  });
});

describe('movement', () => {
  const map = MAPS.space;
  it('blocks walking out of the world', () => {
    let pos = { x: map.spawn.x, y: map.spawn.y };
    for (let i = 0; i < 400; i++) pos = stepMove(map, pos, { x: 0, y: 1 }, 0.05);
    expect(bodyFits(map, pos.x, pos.y)).toBe(true);
    expect(pos.y).toBeLessThan(900);
  });
  it('clamps speed regardless of intent magnitude', () => {
    const a = stepMove(map, map.spawn, { x: 1, y: 0 }, 0.1);
    const b = stepMove(map, map.spawn, { x: 100, y: 0 }, 0.1);
    expect(b.x).toBeCloseTo(a.x, 5);
  });
  it('does not let anyone enter a sealed room but lets occupants leave', () => {
    const room = map.rooms[1]!;
    const sealed = [room];
    const outside = { x: room.x + room.w / 2, y: room.y + room.h + 30 }; // corridor under Command Deck
    let p = outside;
    for (let i = 0; i < 40; i++) p = stepMove(map, p, { x: 0, y: -1 }, 0.05, sealed);
    expect(roomAt(map, p.x, p.y)).not.toBe(room.id);
    let q = { x: room.x + 60, y: room.y + 60 };
    for (let i = 0; i < 10; i++) q = stepMove(map, q, { x: 1, y: 0 }, 0.05, sealed);
    expect(q.x).toBeGreaterThan(room.x + 60);
  });
  it('uses the shared player radius', () => { expect(PLAYER_RADIUS).toBeGreaterThan(0); });
});
