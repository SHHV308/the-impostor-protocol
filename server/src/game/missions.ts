import type { ChallengeAnswer, ChallengePayload, Difficulty, MiniGameKind } from '@impostor/shared';

export type Rng = () => number;

export interface Challenge {
  payload: ChallengePayload;
  /** Never leaves the server. */
  answer: ChallengeAnswer;
  /** Fastest plausible completion time; faster submissions are rejected. */
  minMs: number;
}

const WORDS = ['REACTOR', 'OXYGEN', 'SHIELD', 'ORBIT', 'SIGNAL', 'VECTOR', 'PLASMA', 'BEACON', 'CIRCUIT', 'QUANTUM', 'SAMPLE', 'ENZYME', 'SERVER', 'KERNEL', 'FIREWALL', 'BUNKER', 'RATION', 'FILTER'];
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan'];
const SYMBOLS: [string, string][] = [['O', '0'], ['I', 'l'], ['B', '8'], ['S', '5'], ['M', 'N'], ['E', 'F'], ['Q', 'O'], ['V', 'U']];

const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

export function generateChallenge(kind: MiniGameKind, d: Difficulty, rng: Rng): Challenge {
  switch (kind) {
    case 'sequence': {
      const len = 3 + d * 2;
      const showMs = 600;
      const seq = Array.from({ length: len }, () => int(rng, 0, 3));
      return { payload: { kind, pads: 4, seq, showMs }, answer: seq, minMs: len * showMs * 0.9 + 600 };
    }
    case 'circuit': {
      const n = 3 + d;
      const colors = shuffle(COLORS, rng).slice(0, n);
      const right = shuffle(colors, rng);
      const answer = colors.map((c) => right.indexOf(c));
      return { payload: { kind, colors, right }, answer, minMs: 1200 };
    }
    case 'calibrate': {
      const target = int(rng, 10, 90);
      const tolerance = [0, 9, 6, 4][d]!;
      const labels = ['Coil Voltage', 'Flow Rate', 'Signal Gain', 'Pressure', 'Core Temperature'];
      return { payload: { kind, label: labels[int(rng, 0, labels.length - 1)]!, target, tolerance }, answer: target, minMs: 1500 };
    }
    case 'decode': {
      const word = WORDS[int(rng, 0, WORDS.length - 1)]!;
      const shift = int(rng, 1, 25);
      const cipher = [...word].map((c) => String.fromCharCode(((c.charCodeAt(0) - 65 + shift) % 26) + 65)).join('');
      return { payload: { kind, cipher, shift }, answer: word, minMs: 1500 + word.length * 250 };
    }
    case 'network': {
      const n = 4 + d * 2;
      const pool = new Set<number>();
      while (pool.size < n) pool.add(int(rng, 1, 99));
      const packets = shuffle([...pool], rng);
      return { payload: { kind, packets }, answer: [...pool].sort((a, b) => a - b), minMs: n * 350 };
    }
    case 'odd_one': {
      const cols = 2 + d + 1; // 4,5,6
      const [a, b] = SYMBOLS[int(rng, 0, SYMBOLS.length - 1)]!;
      const grid = Array.from({ length: cols * cols }, () => a);
      const odd = int(rng, 0, grid.length - 1);
      grid[odd] = b;
      return { payload: { kind, cols, grid }, answer: odd, minMs: 700 };
    }
    case 'pattern': {
      const cols = 2 + d; // 3,4,5
      const cells = cols * cols;
      const pattern = Array.from({ length: cells }, () => rng() < 0.4);
      if (!pattern.some(Boolean)) pattern[int(rng, 0, cells - 1)] = true;
      const showMs = 2200;
      return { payload: { kind, cols, pattern, showMs }, answer: pattern, minMs: showMs + 500 };
    }
  }
}

const sameArray = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function verifyAnswer(c: Challenge, submitted: ChallengeAnswer): boolean {
  const { payload, answer } = c;
  switch (payload.kind) {
    case 'calibrate':
      return typeof submitted === 'number' && Math.abs(submitted - (answer as number)) <= payload.tolerance;
    case 'odd_one':
      return typeof submitted === 'number' && submitted === answer;
    case 'decode':
      return typeof submitted === 'string' && submitted.trim().toUpperCase() === answer;
    default:
      return Array.isArray(submitted) && sameArray(submitted, answer as unknown[]);
  }
}
