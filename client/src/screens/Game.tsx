import { useEffect, useRef, useState } from 'react';
import {
  C2S, COOLDOWNS, MAPS, RANGES,
  type GameSnapshot, type Role,
} from '@impostor/shared';
import { audio } from '../audio';
import { emit, getState, pushToast, sendMove, serverNow, useStore } from '../net/socket';
import { GameRenderer } from '../game/renderer';
import { live } from '../game/live';
import { MissionHost } from '../game/minigames/Minigames';
import { ChatBox, SoundControl, useNow } from './components';
import { Meeting } from './Meeting';
import { GameOver, RoleReveal } from './Overlays';
import { ROLE_INFO } from './roles';

type AbilityMode = 'near' | 'station' | 'plain' | 'player' | 'room';
const ABILITIES: Record<string, { label: string; icon: string; cd: number; mode: AbilityMode }> = {
  kill: { label: 'Eliminate', icon: '🗡', cd: COOLDOWNS.kill, mode: 'near' },
  investigate: { label: 'Investigate', icon: '🔍', cd: COOLDOWNS.investigate, mode: 'near' },
  protect: { label: 'Protect', icon: '🛡', cd: COOLDOWNS.protect, mode: 'near' },
  inspect: { label: 'Inspect', icon: '🔧', cd: COOLDOWNS.inspect, mode: 'station' },
  check_logs: { label: 'Logs', icon: '📼', cd: COOLDOWNS.logs, mode: 'plain' },
  disguise: { label: 'Disguise', icon: '🎭', cd: COOLDOWNS.disguise, mode: 'player' },
  plant_evidence: { label: 'Plant', icon: '🧪', cd: COOLDOWNS.plantEvidence, mode: 'player' },
  distract: { label: 'Distract', icon: '📣', cd: COOLDOWNS.distract, mode: 'room' },
};
const ROLE_ABILITIES: Record<Role, string[]> = {
  crew: [], detective: ['investigate'], engineer: ['inspect'], medic: ['protect'], security: ['check_logs'],
  impostor: ['kill', 'distract'], shapeshifter: ['kill', 'disguise', 'plant_evidence', 'distract'],
};

const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const fmt = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function Game() {
  const snap = useStore((s) => s.snapshot);
  const rs = useStore((s) => s.roomState);
  const summary = useStore((s) => s.summary);
  const connected = useStore((s) => s.connected);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const r = new GameRenderer(canvasRef.current!);
    live.me.init = false;
    return () => r.destroy();
  }, []);

  useInput(snap);

  useEffect(() => { if (snap) audio.setScene(snap.env); }, [snap?.env]);
  const sabKey = snap?.sabotage ? `${snap.sabotage.id}:${snap.sabotage.critical}` : '';
  useEffect(() => {
    if (!snap?.sabotage) { audio.setAlarm(false); return; }
    audio.setAlarm(true, snap.sabotage.critical);
    return () => audio.setAlarm(false);
  }, [sabKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="game" data-env={snap?.env}>
      <canvas ref={canvasRef} className="game-canvas" data-testid="canvas-game" />
      {snap && <Hud snap={snap} />}
      {!connected && <div className="banner warn floating" data-testid="banner-reconnecting">Connection lost. Reconnecting…</div>}
      {snap && snap.phase === 'meeting' && snap.meeting && <Meeting snap={snap} />}
      {snap && !summary && <RoleReveal snap={snap} />}
      {(summary || rs?.phase === 'ended') && <GameOver />}
    </div>
  );
}

/** Keyboard + joystick -> live.intent, streamed to the server at 20 Hz. */
function useInput(snap: GameSnapshot | null) {
  const keys = useRef(new Set<string>());
  const joy = useRef({ x: 0, y: 0 });
  const frozen = useRef(false);
  frozen.current = !snap || snap.phase !== 'playing' || !snap.you.alive;
  useEffect(() => {
    const compute = () => {
      const k = keys.current;
      let x = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      let y = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
      if (x === 0 && y === 0) { x = joy.current.x; y = joy.current.y; }
      const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
      return { x, y };
    };
    const typing = (e: Event) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
    const down = (e: KeyboardEvent) => { if (typing(e)) return; const k = e.key.toLowerCase(); if ('wasd'.includes(k) && k.length === 1 || k.startsWith('arrow')) { keys.current.add(k); e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { keys.current.delete(e.key.toLowerCase()); };
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    (window as unknown as { __joy: typeof joy }).__joy = joy;
    let lastX = 0, lastY = 0, sentZero = true;
    const loop = setInterval(() => {
      const v = frozen.current ? { x: 0, y: 0 } : compute();
      live.intent.x = v.x; live.intent.y = v.y;
      const zero = v.x === 0 && v.y === 0;
      if (zero && sentZero) return;
      if (zero || v.x !== lastX || v.y !== lastY || !zero) sendMove(+v.x.toFixed(3), +v.y.toFixed(3));
      sentZero = zero; lastX = v.x; lastY = v.y;
    }, 50);
    return () => {
      clearInterval(loop);
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur);
      live.intent.x = 0; live.intent.y = 0; sendMove(0, 0);
    };
  }, []);
  return joy;
}

function Joystick() {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef<number | null>(null);
  const setJoy = (x: number, y: number) => { const j = (window as unknown as { __joy?: { current: { x: number; y: number } } }).__joy; if (j) j.current = { x, y }; setKnob({ x, y }); };
  const move = (e: React.PointerEvent) => {
    if (active.current !== e.pointerId) return;
    const r = base.current!.getBoundingClientRect(); const R = r.width / 2;
    let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    setJoy(Math.abs(dx) < 0.12 ? 0 : dx, Math.abs(dy) < 0.12 ? 0 : dy);
  };
  const end = (e: React.PointerEvent) => { if (active.current === e.pointerId) { active.current = null; setJoy(0, 0); } };
  return (
    <div ref={base} className="joystick" data-testid="touch-joystick"
      onPointerDown={(e) => { active.current = e.pointerId; (e.target as HTMLElement).setPointerCapture(e.pointerId); move(e); }}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div className="knob" style={{ transform: `translate(${knob.x * 40}px, ${knob.y * 40}px)` }} />
    </div>
  );
}

function Hud({ snap }: { snap: GameSnapshot }) {
  useNow(120);
  const log = useStore((s) => s.log);
  const [tasksOpen, setTasksOpen] = useState(() => window.innerWidth > 720);
  const [picker, setPicker] = useState<null | 'disguise' | 'plant_evidence' | 'distract' | 'sabotage'>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const map = MAPS[snap.env];
  const you = snap.you;
  const now = serverNow();
  const me = live.me;
  const role = ROLE_INFO[you.role];
  const impostor = you.faction === 'impostor';
  const canAct = you.alive && snap.phase === 'playing' && now >= snap.frozenUntil;

  // ---- context actions
  type Ctx = { label: string; d: number; run: () => Promise<{ ok: boolean; error?: string }> };
  const ctxs: Ctx[] = [];
  if (canAct && !you.mission) {
    for (const t of you.tasks) if (!t.done) ctxs.push({ label: `Start: ${t.name}`, d: d2(me, t), run: () => emit(C2S.missionStart, { missionId: t.missionId }) });
    for (const st of snap.sabotage?.stations ?? []) if (!st.fixed) ctxs.push({ label: 'Repair', d: d2(me, st), run: () => emit(C2S.repair, { stationId: st.id }) });
    for (const st of map.stations) {
      if (st.type === 'emergency' && you.emergencyLeft > 0) ctxs.push({ label: 'Emergency meeting', d: d2(me, st), run: () => emit(C2S.emergency) });
      if (st.type === 'security' && you.role === 'security') ctxs.push({ label: 'Check logs', d: d2(me, st), run: () => emit(C2S.ability, { ability: 'check_logs' }) });
    }
  }
  const use = ctxs.filter((c) => c.d <= RANGES.interact).sort((a, b) => a.d - b.d)[0];
  const body = canAct ? snap.bodies.map((b) => ({ b, d: d2(me, b) })).filter((x) => x.d <= RANGES.report).sort((a, b) => a.d - b.d)[0]?.b : undefined;

  const others = snap.players.filter((p) => p.pid !== you.pid && p.alive);
  const nearest = (range: number, skipMates = false) =>
    others.filter((p) => !(skipMates && you.mates.some((m) => m.pid === p.pid))).map((p) => ({ p, d: d2(me, p) })).filter((x) => x.d <= range).sort((a, b) => a.d - b.d)[0]?.p;
  const nearestRepair = map.stations.filter((s) => s.type === 'repair').map((s) => ({ s, d: d2(me, s) })).sort((a, b) => a.d - b.d)[0];

  const run = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    if (!r.ok) pushToast(r.error ?? 'Action failed', 'bad');
    return r;
  };
  const useAbility = (name: string, extra: Record<string, string> = {}) => run(emit(C2S.ability, { ability: name, ...extra }));
  const ability = (name: string) => {
    const meta = ABILITIES[name]!;
    if (meta.mode === 'near') {
      const range = name === 'kill' ? RANGES.kill : name === 'investigate' ? RANGES.investigate : RANGES.protect;
      const t = nearest(range, name === 'kill');
      if (!t) { pushToast('No target in range', 'bad'); return; }
      void useAbility(name, { targetPid: t.pid });
    } else if (meta.mode === 'station') {
      if (!nearestRepair || nearestRepair.d > RANGES.inspect) { pushToast('Move closer to equipment', 'bad'); return; }
      void useAbility(name, { stationId: nearestRepair.s.id });
    } else if (meta.mode === 'plain') void useAbility(name);
    else setPicker(name as 'disguise' | 'plant_evidence' | 'distract');
  };

  const sab = snap.sabotage;
  const sabLeft = sab ? sab.endsAt - now : 0;
  const myTask = you.mission ? you.tasks.find((t) => t.missionId === you.mission!.missionId) : undefined;
  const channelPct = you.channel ? Math.max(0, Math.min(1, 1 - (you.channel.endsAt - now) / (you.role === 'engineer' ? 1500 : 3000))) : 0;

  return (
    <>
      <div className="hud-top">
        <div className="hud-role glass" data-testid="role-badge" style={{ borderColor: role.color }}>
          <b style={{ color: role.color }}>{role.label}</b>
          <small>{map.name}</small>
        </div>
        <div className="hud-center">
          <div className={`meter glass ${snap.progress === null ? 'blackout' : ''}`} data-testid="progress-meter">
            <div className="meter-fill" style={{ width: `${snap.progress ?? 0}%` }} />
            <div className="meter-mark" style={{ left: `${snap.threshold}%` }} />
            <span>{snap.progress === null ? '??? COMMS BLACKOUT ???' : `Missions ${Math.round(snap.progress)}% / ${snap.threshold}%`}</span>
          </div>
          <div className="timer" data-testid="match-timer">{fmt(snap.endsAt - now)}</div>
        </div>
        <div className="hud-right"><SoundControl /></div>
      </div>

      {sab && (
        <div className={`sab-banner ${sab.critical ? 'critical' : ''}`} data-testid="sabotage-banner">
          <b>⚠ {sab.name.toUpperCase()}</b>
          <span>{sab.critical ? `Repair before ${fmt(sabLeft)}` : `Ends in ${fmt(sabLeft)}`} · {sab.stations.filter((s) => !s.fixed).length} station(s) left</span>
        </div>
      )}
      {snap.commsBlackout && <div className="chip warn blackout-chip">Comms blackout: readouts unreliable</div>}
      {snap.lightsOut && <div className="chip warn blackout-chip lights">Lights out: vision limited</div>}

      <div className={`tasks glass ${tasksOpen ? '' : 'closed'}`}>
        <button className="tasks-head" onClick={() => setTasksOpen(!tasksOpen)}>{impostor ? 'Fake tasks' : 'Tasks'} {tasksOpen ? '▾' : '▸'}</button>
        {tasksOpen && (
          <ul>
            {you.tasks.map((t) => (
              <li key={t.missionId} data-testid={`task-${t.missionId}`} className={t.done ? 'done' : ''}>
                <span>{t.done ? '✓' : '○'} {t.name}</span><small>{map.rooms.find((r) => r.id === t.room)?.name ?? t.room}</small>
              </li>
            ))}
          </ul>
        )}
        {impostor && you.mates.length > 0 && <p className="mates">Partner: {you.mates.map((m) => m.name).join(', ')}</p>}
      </div>

      {log.length > 0 && (
        <div className="private-log glass" data-testid="private-log">
          <b>Private intel</b>
          {log.slice(0, 4).map((l) => <div key={l.id}>{formatResult(l.ability, l.data)}</div>)}
        </div>
      )}

      {!you.alive && (
        <div className="spectate-bar glass" data-testid="spectator-banner">
          <b>👻 SPECTATING</b> You cannot vote or talk to the living.
          <button className="btn small" data-testid="btn-follow" onClick={() => {
            const alive = snap.players.filter((p) => p.alive && p.pid !== you.pid);
            if (!alive.length) return;
            const i = alive.findIndex((p) => p.pid === live.followPid);
            live.followPid = alive[(i + 1) % alive.length]!.pid;
          }}>Follow next</button>
          <button className="btn small" onClick={() => setChatOpen(!chatOpen)}>Spectator chat</button>
          {chatOpen && <div className="spectator-chat"><ChatBox channels={['spectator']} placeholder="Spectators only…" /></div>}
        </div>
      )}

      {you.channel && (
        <div className="channel-bar glass"><span>Repairing…</span><div className="bar"><i style={{ width: `${channelPct * 100}%` }} /></div>
          <button className="btn small" onClick={() => void emit(C2S.repairCancel)}>Cancel</button></div>
      )}

      <Joystick />
      <div className="dock">
        {body && <button className="btn danger big" data-testid="btn-report" onClick={() => void run(emit(C2S.report, { bodyId: body.id }))}>REPORT<small>{body.name}</small></button>}
        {use && <button className="btn primary big" data-testid="btn-use" onClick={() => { audio.sfx('click'); void run(use.run()); }}>USE<small>{use.label}</small></button>}
        {canAct && ROLE_ABILITIES[you.role].map((name) => {
          const meta = ABILITIES[name]!;
          const ready = you.cooldowns[name] ?? 0;
          const left = Math.max(0, ready - now);
          const pct = left > 0 ? Math.min(1, left / meta.cd) : 0;
          return (
            <button key={name} className={`ability ${left > 0 ? 'cooling' : ''}`} data-testid={`btn-ability-${name}`} disabled={left > 0}
              style={{ ['--pct' as string]: `${pct * 360}deg` }} onClick={() => ability(name)}>
              <span className="ico">{meta.icon}</span><small>{left > 0 ? `${Math.ceil(left / 1000)}s` : meta.label}</small>
            </button>
          );
        })}
        {canAct && impostor && (
          <button className="ability" data-testid="btn-sabotage-menu" onClick={() => setPicker(picker === 'sabotage' ? null : 'sabotage')}>
            <span className="ico">💥</span><small>Sabotage</small>
          </button>
        )}
      </div>

      {picker && canAct && (
        <div className="picker glass" data-testid="picker">
          <header><b>{picker === 'sabotage' ? 'Sabotage' : picker === 'distract' ? 'Make noise in…' : 'Choose target'}</b><button className="icon-btn" onClick={() => setPicker(null)}>✕</button></header>
          {picker === 'sabotage' && map.sabotages.map((s) => {
            const left = Math.max(0, (you.cooldowns.sabotage ?? 0) - now);
            return (
              <button key={s.id} className="btn" data-testid={`btn-sabotage-${s.id}`} disabled={left > 0 || !!sab} title={s.blurb}
                onClick={() => { setPicker(null); void run(emit(C2S.sabotage, { sabotageId: s.id })); }}>
                {s.name}{s.kind === 'critical' ? ' ⏱' : ''}{left > 0 ? ` (${Math.ceil(left / 1000)}s)` : ''}
              </button>
            );
          })}
          {(picker === 'disguise' || picker === 'plant_evidence') && others.map((p) => (
            <button key={p.pid} className="btn" data-testid={`pick-${p.pid}`} onClick={() => { setPicker(null); void useAbility(picker, { targetPid: p.pid }); }}>
              <i className="dot" style={{ background: p.color }} /> {p.name}
            </button>
          ))}
          {picker === 'distract' && map.rooms.map((r) => (
            <button key={r.id} className="btn" onClick={() => { setPicker(null); void useAbility('distract', { roomId: r.id }); }}>{r.name}</button>
          ))}
        </div>
      )}

      <MissionHost mission={you.mission} taskName={myTask?.name ?? 'Mission'} />
    </>
  );
}

function formatResult(ability: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  if (ability === 'investigate') {
    const who = typeof d.targetName === 'string' ? `${d.targetName}: ` : '';
    return `🔍 ${who}${d.suspicious ? 'SUSPICIOUS' : 'Not suspicious'}`;
  }
  if (ability === 'check_logs' && Array.isArray(d.entries)) {
    const rows = (d.entries as { t?: number; name?: string; room?: string }[]).slice(-6)
      .map((e) => `${e.name ?? '?'} @ ${e.room ?? '?'}`).join(' · ');
    return `📼 ${rows || 'No movement recorded'}`;
  }
  if (typeof data === 'string') return `${ability}: ${data}`;
  return `${ability}: ${Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ') || 'ok'}`;
}

void getState;
