import type { Role } from '@impostor/shared';

export const ROLE_INFO: Record<Role, { label: string; color: string; blurb: string }> = {
  detective: { label: 'Detective', color: '#60a5fa', blurb: 'Investigate one player at a time for a suspicious / not-suspicious clue.' },
  engineer: { label: 'Engineer', color: '#fbbf24', blurb: 'Repair sabotage twice as fast and inspect damaged equipment.' },
  medic: { label: 'Medic', color: '#4ade80', blurb: 'Shield one player from an elimination attempt.' },
  security: { label: 'Security Officer', color: '#22d3ee', blurb: 'Read movement logs at the security console.' },
  crew: { label: 'Crew Member', color: '#cbd5e1', blurb: 'Complete missions and vote out the impostor.' },
  impostor: { label: 'Impostor', color: '#ff4d6d', blurb: 'Eliminate crew, sabotage the station, stay hidden.' },
  shapeshifter: { label: 'Shapeshifter', color: '#f472b6', blurb: 'Impostor who can disguise and plant misleading evidence.' },
};
