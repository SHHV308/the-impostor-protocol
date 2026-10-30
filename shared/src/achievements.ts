export const ACHIEVEMENTS: Record<string, { title: string; description: string }> = {
  first_mission: { title: 'First Mission', description: 'Complete your first validated mission.' },
  master_detective: { title: 'Master Detective', description: 'Flag impostors as suspicious three times as the Detective.' },
  perfect_sabotage: { title: 'Perfect Sabotage', description: 'Win as an impostor when a critical sabotage runs out the clock.' },
  last_survivor: { title: 'Last Survivor', description: 'Survive to the end of a match where at least half the other players fell.' },
  trusted_engineer: { title: 'Trusted Engineer', description: 'Complete three repairs as the Engineer.' },
  impostor_victory: { title: 'Impostor Victory', description: 'Win a match on the impostor side.' },
  crew_hero: { title: 'Crew Hero', description: 'Win as crew after completing at least four missions yourself.' },
  no_evidence: { title: 'No Evidence Left Behind', description: 'Win as an impostor with at least one elimination and no body ever reported.' },
};

/** Level curve: each level needs 100 more XP than the last. */
export function levelFromXp(xp: number): number {
  let level = 1, need = 100, left = xp;
  while (left >= need) { left -= need; level++; need += 100; }
  return level;
}
