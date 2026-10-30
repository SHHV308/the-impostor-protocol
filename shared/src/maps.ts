import type {
  EnvironmentId, MapDef, MiniGameKind, MissionCategory, MissionDef, Rect, RoomDef, SabotageDef, StationDef,
} from './types.js';

const CORRIDOR_W = 70;

type RoomSpec = [name: string, x: number, y: number, w: number, h: number];
type MissionSpec = [name: string, category: MissionCategory, kind: MiniGameKind];

interface Spec {
  id: EnvironmentId;
  name: string;
  tagline: string;
  palette: MapDef['palette'];
  rooms: RoomSpec[];
  links: [number, number][];
  emergencyRoom: number;
  securityRoom: number;
  missions: MissionSpec[];
  sabotages: SabotageDef[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** L-shaped corridor between two room centres: horizontal leg then vertical leg. */
function corridor(a: RoomDef, b: RoomDef): Rect[] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const h = CORRIDOR_W / 2;
  return [
    { x: Math.min(ax, bx) - h, y: ay - h, w: Math.abs(bx - ax) + CORRIDOR_W, h: CORRIDOR_W },
    { x: bx - h, y: Math.min(ay, by) - h, w: CORRIDOR_W, h: Math.abs(by - ay) + CORRIDOR_W },
  ];
}

function build(spec: Spec): MapDef {
  const rooms: RoomDef[] = spec.rooms.map(([name, x, y, w, h]) => ({ id: slug(name), name, x, y, w, h }));
  const corridors = spec.links.flatMap(([i, j]) => corridor(rooms[i]!, rooms[j]!));
  // one table-sized prop at the centre of each room
  const obstacles: Rect[] = rooms.map((r) => ({ x: r.x + r.w / 2 - 34, y: r.y + r.h / 2 - 24, w: 68, h: 48 }));

  const missions: MissionDef[] = spec.missions.map(([name, category, kind], i) => ({
    id: `${spec.id}_m${i}`, name, category, kind, room: rooms[i % rooms.length]!.id,
  }));

  const stations: StationDef[] = [];
  missions.forEach((m, i) => {
    const room = rooms[i % rooms.length]!;
    const slot = Math.floor(i / rooms.length);
    stations.push({ id: `st_${m.id}`, type: 'mission', x: room.x + room.w * (slot === 0 ? 0.25 : 0.75), y: room.y + 46, room: room.id, missionId: m.id });
  });
  rooms.forEach((r) => stations.push({ id: `rs_${r.id}`, type: 'repair', x: r.x + r.w / 2, y: r.y + r.h - 40, room: r.id }));
  const em = rooms[spec.emergencyRoom]!;
  stations.push({ id: 'emergency', type: 'emergency', x: em.x + em.w / 2, y: em.y + 46, room: em.id });
  const sec = rooms[spec.securityRoom]!;
  stations.push({ id: 'security', type: 'security', x: sec.x + sec.w - 46, y: sec.y + sec.h / 2, room: sec.id });

  return {
    id: spec.id, name: spec.name, tagline: spec.tagline, palette: spec.palette,
    rooms, corridors, obstacles, stations, missions, sabotages: spec.sabotages,
    spawn: { x: em.x + em.w / 2, y: em.y + em.h / 2 + 80 },
  };
}

const SPACE: Spec = {
  id: 'space', name: 'Space Station', tagline: 'Keep the reactor burning and the oxygen flowing.',
  palette: { bg: '#040a1c', floor: '#0e2748', wall: '#27b4e6', accent: '#22d3ee', accent2: '#3b82f6', danger: '#ff4d6d' },
  rooms: [
    ['Reactor Core', 100, 80, 400, 300], ['Command Deck', 600, 80, 400, 300], ['Engine Control', 1100, 80, 400, 300],
    ['Oxygen Systems', 100, 560, 400, 300], ['Navigation', 600, 560, 400, 300], ['Power Grid', 1100, 560, 400, 300],
  ],
  links: [[0, 1], [1, 2], [3, 4], [4, 5], [0, 3], [1, 4], [2, 5]],
  emergencyRoom: 1, securityRoom: 4,
  missions: [
    ['Reconnect Power', 'logic', 'circuit'], ['Align Navigation Systems', 'logic', 'sequence'], ['Plot Star Chart', 'logic', 'pattern'],
    ['Repair Reactor', 'repair', 'calibrate'], ['Restore Oxygen', 'repair', 'circuit'], ['Tune Engine Coils', 'repair', 'calibrate'],
    ['Decrypt Station Log', 'hacking', 'decode'], ['Reroute Comms Relay', 'hacking', 'network'], ['Unlock Airlock Code', 'hacking', 'decode'],
    ['Scan Hull Breach', 'investigation', 'odd_one'], ['Match Debris Pattern', 'investigation', 'pattern'], ['Identify Radiation Source', 'investigation', 'odd_one'],
  ],
  sabotages: [
    { id: 'oxygen_leak', name: 'Oxygen Leak', kind: 'critical', blurb: 'Oxygen is venting. Repair both oxygen consoles before time runs out.' },
    { id: 'power_failure', name: 'Power Failure', kind: 'lights_out', blurb: 'Lights are out; vision is limited.' },
    { id: 'locked_doors', name: 'Locked Doors', kind: 'locked_doors', blurb: 'A section is sealed off.' },
    { id: 'engine_malfunction', name: 'Engine Malfunction', kind: 'env_trap', blurb: 'Venting plasma creates deadly hazard zones.' },
  ],
};

const LAB: Spec = {
  id: 'lab', name: 'Secret Laboratory', tagline: 'Something in the samples is wrong.',
  palette: { bg: '#0c0616', floor: '#1d1233', wall: '#8b5cf6', accent: '#a3e635', accent2: '#a855f7', danger: '#fb7185' },
  rooms: [
    ['Sample Vault', 80, 60, 360, 260], ['Chemical Lab', 520, 60, 520, 320], ['Containment', 1120, 60, 400, 260],
    ['Data Archive', 80, 450, 360, 300], ['Atrium', 560, 500, 440, 300], ['Experiment Bay', 1120, 450, 400, 300],
  ],
  links: [[0, 1], [1, 2], [0, 3], [3, 4], [4, 5], [1, 4], [2, 5]],
  emergencyRoom: 4, securityRoom: 0,
  missions: [
    ['Match Chemical Patterns', 'logic', 'pattern'], ['Balance Reagent Flow', 'logic', 'sequence'], ['Wire Centrifuge', 'logic', 'circuit'],
    ['Complete Experiments', 'repair', 'calibrate'], ['Calibrate Spectrometer', 'repair', 'calibrate'], ['Fix Fume Hood', 'repair', 'circuit'],
    ['Secure Research Data', 'hacking', 'decode'], ['Restore Lab Network', 'hacking', 'network'], ['Crack Vault Lock', 'hacking', 'decode'],
    ['Analyze Samples', 'investigation', 'odd_one'], ['Identify Contaminant', 'investigation', 'odd_one'], ['Compare DNA Strands', 'investigation', 'pattern'],
  ],
  sabotages: [
    { id: 'contaminate_samples', name: 'Contaminate Samples', kind: 'critical', blurb: 'Contamination is spreading. Purge both sample banks.' },
    { id: 'damage_experiments', name: 'Damage Experiments', kind: 'env_trap', blurb: 'Chemical spills pool across the floor.' },
    { id: 'lock_lab_access', name: 'Lock Laboratory Access', kind: 'locked_doors', blurb: 'A lab section is sealed.' },
    { id: 'falsify_results', name: 'Falsify Research Results', kind: 'fake_alerts', blurb: 'The progress readout is lying.' },
  ],
};

const CYBER: Spec = {
  id: 'cyber', name: 'Cybersecurity Facility', tagline: 'The breach is already inside the network.',
  palette: { bg: '#05071a', floor: '#0c1233', wall: '#6d4aff', accent: '#3b8bff', accent2: '#d946ef', danger: '#ff4d8d' },
  rooms: [
    ['Server Room', 60, 60, 380, 260], ['Firewall Control', 620, 40, 360, 200], ['Security Ops', 1160, 60, 380, 260],
    ['Network Core', 550, 340, 500, 330], ['Data Vault', 60, 700, 380, 260], ['Terminal Lab', 620, 760, 360, 200], ['Comms Hub', 1160, 700, 380, 260],
  ],
  links: [[3, 0], [3, 1], [3, 2], [3, 4], [3, 5], [3, 6]],
  emergencyRoom: 3, securityRoom: 2,
  missions: [
    ['Decode Passwords', 'hacking', 'decode'], ['Restore Compromised Servers', 'hacking', 'network'], ['Bypass Firewall Rule', 'hacking', 'decode'],
    ['Repair Network Connections', 'repair', 'circuit'], ['Tune Signal Gain', 'repair', 'calibrate'], ['Replace Server Fan', 'repair', 'calibrate'],
    ['Identify Malware', 'investigation', 'odd_one'], ['Trace Intruder Packets', 'investigation', 'pattern'], ['Spot Phishing Mail', 'investigation', 'odd_one'],
    ['Patch Exploit Sequence', 'logic', 'sequence'], ['Solve Access Matrix', 'logic', 'pattern'], ['Reroute Fibre Links', 'logic', 'circuit'],
  ],
  sabotages: [
    { id: 'comms_blackout', name: 'Communications Blackout', kind: 'comms_blackout', blurb: 'Progress readouts and logs go dark.' },
    { id: 'malware_injection', name: 'Malware Injection', kind: 'critical', blurb: 'Malware is spreading. Quarantine both infected consoles.' },
    { id: 'camera_disruption', name: 'Security Camera Disruption', kind: 'lights_out', blurb: 'Cameras are down; visibility is limited.' },
    { id: 'fake_alerts', name: 'Fake Mission Alerts', kind: 'fake_alerts', blurb: 'False alerts inflate the mission readout.' },
  ],
};

const BUNKER: Spec = {
  id: 'bunker', name: 'Underground Bunker', tagline: 'Rations are low and the air is thin.',
  palette: { bg: '#100d09', floor: '#2d2721', wall: '#c27a1a', accent: '#f59e0b', accent2: '#ea580c', danger: '#ef4444' },
  rooms: [
    ['Entrance Hall', 80, 100, 360, 260], ['Supply Storage', 560, 100, 360, 260], ['Ventilation Plant', 1040, 100, 460, 260],
    ['Defense Control', 80, 560, 360, 280], ['Command Bunker', 560, 560, 360, 280], ['Life Support', 1040, 560, 460, 280],
  ],
  links: [[0, 1], [1, 2], [2, 5], [5, 4], [4, 3], [1, 4]],
  emergencyRoom: 4, securityRoom: 3,
  missions: [
    ['Manage Supplies', 'logic', 'sequence'], ['Ration Allocation', 'logic', 'pattern'], ['Reroute Generator Power', 'logic', 'circuit'],
    ['Repair Ventilation', 'repair', 'calibrate'], ['Restore Life Support', 'repair', 'circuit'], ['Maintain Defenses', 'repair', 'calibrate'],
    ['Unlock Blast Door', 'hacking', 'decode'], ['Reconnect Radio Mast', 'hacking', 'network'], ['Override Turret Code', 'hacking', 'decode'],
    ['Inspect Spoiled Rations', 'investigation', 'odd_one'], ['Trace Gas Leak', 'investigation', 'pattern'], ['Find Tampered Crate', 'investigation', 'odd_one'],
  ],
  sabotages: [
    { id: 'poison_supplies', name: 'Poison Supplies', kind: 'critical', blurb: 'The food stores are tainted. Purge both supply lines.' },
    { id: 'damage_ventilation', name: 'Damage Ventilation', kind: 'lights_out', blurb: 'Smoke fills the corridors; vision is limited.' },
    { id: 'disable_defenses', name: 'Disable Defenses', kind: 'locked_doors', blurb: 'Blast doors slam shut on a section.' },
    { id: 'environmental_traps', name: 'Environmental Traps', kind: 'env_trap', blurb: 'Gas pockets and live wires appear.' },
  ],
};

export const MAPS: Record<EnvironmentId, MapDef> = {
  space: build(SPACE), lab: build(LAB), cyber: build(CYBER), bunker: build(BUNKER),
};

export function getMap(id: EnvironmentId): MapDef { return MAPS[id]; }
