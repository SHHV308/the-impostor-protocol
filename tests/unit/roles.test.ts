import { describe, expect, it } from 'vitest';
import { FACTION_OF } from '@impostor/shared';
import type { Role } from '@impostor/shared';
import { assignRoles } from '../../server/src/game/engine.js';
import { makeEngine, mulberry32 } from './helpers.js';

describe('role assignment', () => {
  for (let n = 4; n <= 10; n++) {
    it(`${n} players: correct impostor count and unique special roles`, () => {
      for (let seed = 1; seed <= 50; seed++) {
        const roles = assignRoles(n, mulberry32(seed));
        expect(roles).toHaveLength(n);
        const imps = roles.filter((r) => FACTION_OF[r] === 'impostor');
        expect(imps).toHaveLength(n >= 8 ? 2 : 1);
        if (n >= 8) expect(new Set(imps).size).toBe(2); // two different variants
        const specials = roles.filter((r) => r !== 'crew' && FACTION_OF[r] === 'crew');
        expect(new Set(specials).size).toBe(specials.length);
        const nonSpecial = roles.filter((r) => r === 'crew').length;
        expect(nonSpecial).toBeGreaterThanOrEqual(1);
      }
    });
  }

  it('picks both single-impostor variants across seeds', () => {
    const seen = new Set<Role>();
    for (let s = 1; s < 40; s++) seen.add(assignRoles(5, mulberry32(s)).find((r) => FACTION_OF[r] === 'impostor')!);
    expect(seen).toEqual(new Set(['impostor', 'shapeshifter']));
  });

  it('gives every player only their own role event, privately', () => {
    const h = makeEngine(10);
    const reveals = h.events.filter((e) => e.event.type === 'role_reveal');
    expect(reveals).toHaveLength(10);
    for (const r of reveals) expect(r.target.to).toBe('pid');
    const broadcast = h.events.filter((e) => e.target.to === 'all');
    expect(JSON.stringify(broadcast)).not.toMatch(/detective|engineer|medic|shapeshifter|impostor/);
  });

  it('never includes other players roles in anyone snapshot (crew view)', () => {
    const h = makeEngine(10);
    h.start();
    const crew = h.crewPids()[0]!;
    const snap = JSON.parse(JSON.stringify(h.engine.snapshotFor(crew)));
    expect(snap.you.mates).toEqual([]);
    const others = JSON.stringify({ ...snap, you: undefined });
    expect(others).not.toMatch(/"role"|faction|detective|shapeshifter/);
  });

  it('shows impostors their allies only', () => {
    const h = makeEngine(10);
    const [a, b] = h.impostorPids();
    const snapA = h.engine.snapshotFor(a!);
    expect(snapA.you.mates.map((m) => m.pid)).toEqual([b]);
  });
});
