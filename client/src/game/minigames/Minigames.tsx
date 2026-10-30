import { useEffect, useMemo, useRef, useState } from 'react';
import { C2S, type ActiveChallenge, type ChallengeAnswer, type ChallengePayload } from '@impostor/shared';
import { emit } from '../../net/socket';
import { audio } from '../../audio';

type Payload<K extends ChallengePayload['kind']> = Extract<ChallengePayload, { kind: K }>;
interface GameProps<K extends ChallengePayload['kind']> { p: Payload<K>; submit: (a: ChallengeAnswer) => void; busy: boolean }

const PAD_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb923c', '#38bdf8', '#f87171', '#2dd4bf'];

function Sequence({ p, submit, busy }: GameProps<'sequence'>) {
  const [phase, setPhase] = useState<'show' | 'input'>('show');
  const [lit, setLit] = useState<number | null>(null);
  const [entered, setEntered] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    p.seq.forEach((pad, i) => {
      timers.push(setTimeout(() => { if (!cancelled) { setLit(pad); audio.sfx('click'); } }, 700 + i * p.showMs));
      timers.push(setTimeout(() => { if (!cancelled) setLit(null); }, 700 + i * p.showMs + p.showMs * 0.7));
    });
    timers.push(setTimeout(() => { if (!cancelled) setPhase('input'); }, 700 + p.seq.length * p.showMs));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [p.seq.join(','), p.showMs]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = Math.ceil(Math.sqrt(p.pads));
  const press = (i: number) => {
    if (phase !== 'input' || busy) return;
    audio.sfx('click');
    setLit(i); setTimeout(() => setLit(null), 150);
    const next = [...entered, i];
    setEntered(next);
    if (next.length === p.seq.length) submit(next);
  };
  return (
    <div>
      <p className="mg-hint">{phase === 'show' ? 'Watch the sequence…' : `Repeat it (${entered.length}/${p.seq.length})`}</p>
      <div className="pads" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {Array.from({ length: p.pads }, (_, i) => (
          <button key={i} className={`pad ${lit === i ? 'lit' : ''}`} style={{ '--c': PAD_COLORS[i % PAD_COLORS.length] } as React.CSSProperties} onClick={() => press(i)} aria-label={`pad ${i + 1}`} />
        ))}
      </div>
    </div>
  );
}

const cssColor = (s: string) => (typeof CSS !== 'undefined' && CSS.supports('color', s) ? s : `hsl(${[...s].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360} 80% 55%)`);

function Circuit({ p, submit, busy }: GameProps<'circuit'>) {
  const n = p.colors.length;
  const [sel, setSel] = useState<number | null>(null);
  const [map, setMap] = useState<(number | null)[]>(Array(n).fill(null));
  const connect = (j: number) => {
    if (sel === null) return;
    const next = map.map((v) => (v === j ? null : v));
    next[sel] = j; setMap(next); setSel(null); audio.sfx('click');
  };
  const done = map.every((v) => v !== null);
  const rowY = (i: number) => 30 + i * 52;
  return (
    <div>
      <p className="mg-hint">Pick a wire on the left, then its matching colour on the right.</p>
      <div className="circuit">
        <svg viewBox={`0 0 300 ${n * 52 + 20}`} className="circuit-lines">
          {map.map((j, i) => j !== null && <line key={i} x1={20} y1={rowY(i)} x2={280} y2={rowY(j)} stroke={cssColor(p.colors[i]!)} strokeWidth={6} strokeLinecap="round" />)}
        </svg>
        <div className="col left">{p.colors.map((c, i) => (
          <button key={i} className={`node ${sel === i ? 'sel' : ''}`} style={{ background: cssColor(c) }} onClick={() => setSel(i)} title={c}><span>{c}</span></button>
        ))}</div>
        <div className="col right">{p.right.map((c, j) => (
          <button key={j} className="node" style={{ background: cssColor(c) }} onClick={() => connect(j)} title={c}><span>{c}</span></button>
        ))}</div>
      </div>
      <button className="btn primary" disabled={!done || busy} onClick={() => submit(map as number[])}>Verify circuit</button>
    </div>
  );
}

function Calibrate({ p, submit, busy }: GameProps<'calibrate'>) {
  const [v, setV] = useState(50);
  const inBand = Math.abs(v - p.target) <= p.tolerance;
  return (
    <div>
      <p className="mg-hint">{p.label}: align the needle with the green band.</p>
      <div className="gauge">
        <div className="band" style={{ left: `${p.target - p.tolerance}%`, width: `${p.tolerance * 2}%` }} />
        <div className={`needle ${inBand ? 'ok' : ''}`} style={{ left: `${v}%` }} />
      </div>
      <input className="slider" type="range" min={0} max={100} step={1} value={v} onChange={(e) => setV(Number(e.target.value))} />
      <div className="mg-row"><span>{v}%</span><button className="btn primary" disabled={busy} onClick={() => submit(v)}>Lock in</button></div>
    </div>
  );
}

const SHIFT_NOTE = 'Each letter of the original word was shifted forward in the alphabet by the key.';
function Decode({ p, submit, busy }: GameProps<'decode'>) {
  const [txt, setTxt] = useState('');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ok = txt.length > 0;
  return (
    <div>
      <p className="mg-hint">Decrypt the intercepted word. {SHIFT_NOTE}</p>
      <div className="cipher">{p.cipher}</div>
      <p className="mg-key">Key: +{p.shift}</p>
      <div className="wheel"><div>{[...A].map((l) => <i key={l}>{l}</i>)}</div><div>{[...A].map((_, i) => <i key={i}>{A[(i + p.shift) % 26]}</i>)}</div></div>
      <input className="input mono" autoFocus value={txt} maxLength={16} placeholder="PLAINTEXT"
        onChange={(e) => setTxt(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) submit(txt); }} />
      <button className="btn primary" disabled={!ok || busy} onClick={() => submit(txt)}>Submit</button>
    </div>
  );
}

function Network({ p, submit, busy }: GameProps<'network'>) {
  const [order, setOrder] = useState<number[]>([]);
  const click = (idx: number) => {
    if (busy) return;
    const next = [...order, idx];
    setOrder(next); audio.sfx('click');
    if (next.length === p.packets.length) submit(next.map((i) => p.packets[i]!));
  };
  return (
    <div>
      <p className="mg-hint">Restore the connection: route the packets in ascending order.</p>
      <div className="packets">
        {p.packets.map((v, i) => (
          <button key={i} className={`packet ${order.includes(i) ? 'used' : ''}`} disabled={order.includes(i) || busy} onClick={() => click(i)}>{v}</button>
        ))}
      </div>
      <p className="mg-key">Routed: {order.map((i) => p.packets[i]).join(' → ') || '—'}</p>
      <button className="btn" onClick={() => setOrder([])} disabled={busy || order.length === 0}>Reset</button>
    </div>
  );
}

function OddOne({ p, submit, busy }: GameProps<'odd_one'>) {
  return (
    <div>
      <p className="mg-hint">One sample is different. Find it.</p>
      <div className="odd" style={{ gridTemplateColumns: `repeat(${p.cols}, 1fr)` }}>
        {p.grid.map((g, i) => <button key={i} className="cell" disabled={busy} onClick={() => submit(i)}>{g}</button>)}
      </div>
    </div>
  );
}

function Pattern({ p, submit, busy }: GameProps<'pattern'>) {
  const [showing, setShowing] = useState(true);
  const [cells, setCells] = useState<boolean[]>(() => p.pattern.map(() => false));
  useEffect(() => { const t = setTimeout(() => setShowing(false), p.showMs + 400); return () => clearTimeout(t); }, [p.showMs]);
  const shown = showing ? p.pattern : cells;
  return (
    <div>
      <p className="mg-hint">{showing ? 'Memorise the pattern…' : 'Recreate it.'}</p>
      <div className="odd" style={{ gridTemplateColumns: `repeat(${p.cols}, 1fr)` }}>
        {shown.map((on, i) => (
          <button key={i} className={`cell pat ${on ? 'on' : ''}`} disabled={showing || busy}
            onClick={() => { audio.sfx('click'); setCells(cells.map((c, k) => (k === i ? !c : c))); }} />
        ))}
      </div>
      <button className="btn primary" disabled={showing || busy} onClick={() => submit(cells)}>Submit pattern</button>
    </div>
  );
}

const TITLES: Record<ChallengePayload['kind'], string> = {
  sequence: 'Sequence Matching', circuit: 'Circuit Connection', calibrate: 'Equipment Calibration', decode: 'Password Decoding',
  network: 'Network Restoration', odd_one: 'Sample Identification', pattern: 'Pattern Recognition',
};

/** Full-screen mission modal driven by `you.mission`. */
export function MissionHost({ mission, taskName }: { mission: ActiveChallenge | null; taskName: string }) {
  const [outcome, setOutcome] = useState<'success' | 'fail' | null>(null);
  const [busy, setBusy] = useState(false);
  const kept = useRef<ActiveChallenge | null>(null);
  if (mission) kept.current = mission;
  const ch = mission ?? (outcome ? kept.current : null);
  const submittedFor = useRef<string | null>(null);

  useEffect(() => { if (mission) { setOutcome(null); setBusy(false); submittedFor.current = null; } }, [mission?.startedAt, mission?.missionId]);

  const submit = async (answer: ChallengeAnswer) => {
    if (!ch || busy || submittedFor.current === `${ch.startedAt}`) return;
    submittedFor.current = `${ch.startedAt}`; setBusy(true);
    const res = await emit<{ correct: boolean }>(C2S.missionSubmit, { missionId: ch.missionId, answer });
    const good = res.ok && res.correct;
    setOutcome(good ? 'success' : 'fail'); setBusy(false);
    audio.sfx(good ? 'mission' : 'fail');
    setTimeout(() => setOutcome(null), 1100);
  };
  const cancel = () => { void emit(C2S.missionCancel); setOutcome(null); };
  const body = useMemo(() => {
    if (!ch) return null;
    const p = ch.payload;
    const key = `${ch.missionId}:${ch.startedAt}`;
    switch (p.kind) {
      case 'sequence': return <Sequence key={key} p={p} submit={submit} busy={busy} />;
      case 'circuit': return <Circuit key={key} p={p} submit={submit} busy={busy} />;
      case 'calibrate': return <Calibrate key={key} p={p} submit={submit} busy={busy} />;
      case 'decode': return <Decode key={key} p={p} submit={submit} busy={busy} />;
      case 'network': return <Network key={key} p={p} submit={submit} busy={busy} />;
      case 'odd_one': return <OddOne key={key} p={p} submit={submit} busy={busy} />;
      case 'pattern': return <Pattern key={key} p={p} submit={submit} busy={busy} />;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch?.missionId, ch?.startedAt, busy]);

  if (!ch) return null;
  return (
    <div className="modal-backdrop" data-testid="mission-modal">
      <div className={`modal mission ${outcome ?? ''}`}>
        <header><h3>{taskName}</h3><span className="chip">{TITLES[ch.payload.kind]} · {['', 'Easy', 'Medium', 'Hard'][ch.difficulty]}</span></header>
        {body}
        {outcome && <div className={`outcome ${outcome}`}>{outcome === 'success' ? '✓ COMPLETE' : '✕ FAILED'}</div>}
        <footer><button className="btn ghost" onClick={cancel} data-testid="btn-mission-cancel">Cancel</button></footer>
      </div>
    </div>
  );
}
