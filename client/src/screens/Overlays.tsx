import { useEffect, useState } from 'react';
import { C2S, MAPS, type GameSnapshot } from '@impostor/shared';
import { emit, leaveRoom, pushToast, serverNow, useStore } from '../net/socket';
import { AvatarChip, useNow } from './components';
import { ROLE_INFO } from './roles';

/** Animated secret role reveal shown during the start-of-match freeze. */
export function RoleReveal({ snap }: { snap: GameSnapshot }) {
  useNow(150);
  const [seen, setSeen] = useState(false);
  const left = snap.frozenUntil - serverNow();
  useEffect(() => { if (left <= 0) setSeen(true); }, [left]);
  if (left <= 0 || seen) return null;
  const r = ROLE_INFO[snap.you.role];
  const impostor = snap.you.faction === 'impostor';
  return (
    <div className={`role-reveal ${impostor ? 'impostor' : 'crew'}`} data-testid="role-reveal">
      <small className="eyebrow">{impostor ? 'THERE IS NO CREW. ONLY PREY.' : 'SHIPMATES, STAY ALERT'}</small>
      <h1 style={{ color: r.color }} data-testid="role-reveal-name">{r.label}</h1>
      <p>{r.blurb}</p>
      {impostor && snap.you.mates.length > 0 && <p className="mates">Your partner: <b>{snap.you.mates.map((m) => m.name).join(', ')}</b></p>}
      <div className="reveal-bar"><i style={{ animationDuration: `${Math.max(1, left)}ms` }} /></div>
      <small>{MAPS[snap.env].name}</small>
    </div>
  );
}

export function GameOver() {
  const summary = useStore((s) => s.summary);
  const rs = useStore((s) => s.roomState);
  const snap = useStore((s) => s.snapshot);
  const isHost = !!rs && rs.hostPid === rs.youPid;
  const myFaction = snap?.you.faction;
  const won = summary && myFaction ? summary.winner === myFaction : false;
  const [busy, setBusy] = useState(false);

  const rematch = async () => {
    setBusy(true);
    const r = await emit(C2S.rematch);
    setBusy(false);
    if (!r.ok) pushToast(r.error, 'bad');
  };
  const REASONS: Record<string, string> = {
    missions: 'The crew completed their missions.', impostors_voted: 'Every impostor was voted out.', parity: 'The impostors outnumber the crew.',
    sabotage: 'A critical sabotage ran out the clock.', timer: 'Time ran out.', abandoned: 'The rest of the players left.',
  };
  return (
    <div className={`game-over ${summary ? (won ? 'victory' : 'defeat') : ''}`} data-testid="game-over">
      <div className="go-card glass">
        {summary ? (
          <>
            <small className="eyebrow">{summary.winner === 'crew' ? 'CREW VICTORY' : 'IMPOSTOR VICTORY'}</small>
            <h1 data-testid="go-result">{won ? 'VICTORY' : 'DEFEAT'}</h1>
            <p>{REASONS[summary.reason] ?? ''} · Team score {summary.teamScore} · {Math.round(summary.progress)}% missions</p>
            <h4>Secret roles revealed</h4>
            <ul className="reveal-list" data-testid="role-reveal-list">
              {[...summary.players].sort((a, b) => b.xp - a.xp).map((p) => (
                <li key={p.pid} className={`${p.faction} ${p.alive ? '' : 'dead'}`}>
                  <AvatarChip avatar={p.avatar} color={p.color} size={32} />
                  <b>{p.name}</b>
                  <span className="role" style={{ color: ROLE_INFO[p.role].color }}>{ROLE_INFO[p.role].label}</span>
                  <span className="muted">{p.alive ? 'survived' : 'eliminated'} · {p.missions} missions · {p.kills} kills</span>
                  <span className="xp">+{p.xp} XP</span>
                </li>
              ))}
            </ul>
          </>
        ) : <h2>Match ended</h2>}
        <div className="actions">
          {isHost && <button className="btn primary" data-testid="btn-rematch" disabled={busy} onClick={() => void rematch()}>Rematch</button>}
          {!isHost && <p className="hint">Waiting for the host to start a rematch…</p>}
          <button className="btn ghost" data-testid="btn-leave" onClick={() => void leaveRoom()}>Leave</button>
        </div>
      </div>
    </div>
  );
}
