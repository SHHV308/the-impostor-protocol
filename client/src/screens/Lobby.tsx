import { useState } from 'react';
import { AVATARS, C2S, ENVIRONMENTS, LIMITS, MAPS, type Avatar, type Settings } from '@impostor/shared';
import { audio } from '../audio';
import { emit, leaveRoom, pushToast, useStore } from '../net/socket';
import { AvatarChip, ChatBox, SoundControl } from './components';

export function Lobby() {
  const rs = useStore((s) => s.roomState)!;
  const connected = useStore((s) => s.connected);
  const [error, setError] = useState('');
  const me = rs.players.find((p) => p.pid === rs.youPid);
  const isHost = rs.hostPid === rs.youPid;
  const st = rs.settings;
  const link = `${location.origin}/?room=${rs.code}`;

  const act = async (event: string, payload?: unknown) => {
    setError('');
    const res = await emit(event, payload);
    if (!res.ok) setError(res.error);
  };
  const setSetting = (patch: Partial<Settings>) => void act(C2S.settings, patch);

  const others = rs.players.filter((p) => !p.isHost);
  const notReady = others.filter((p) => !p.ready).length;
  const startBlock =
    rs.players.length < rs.minPlayers ? `Need at least ${rs.minPlayers} players (${rs.players.length} here)` :
    notReady > 0 ? `Waiting for ${notReady} player${notReady > 1 ? 's' : ''} to ready up` : '';

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); pushToast('Invite link copied', 'good'); }
    catch { pushToast(link); }
  };

  return (
    <div className="lobby">
      <div className="topbar"><span className="logo-sm">THE IMPOSTOR PROTOCOL</span><SoundControl /></div>
      {!connected && <div className="banner warn" data-testid="banner-reconnecting">Connection lost. Reconnecting…</div>}
      <div className="lobby-grid">
        <section className="glass">
          <div className="room-head">
            <div><small>ROOM CODE</small><div className="room-code" data-testid="room-code">{rs.code}</div></div>
            <div className="room-actions">
              <button className="btn" data-testid="btn-copy-link" onClick={() => void copy()}>Copy invite link</button>
              <button className="btn ghost" data-testid="btn-leave" onClick={() => void leaveRoom()}>Leave</button>
            </div>
          </div>
          <h4>Players ({rs.players.length}/{rs.maxPlayers})</h4>
          <ul className="player-list" data-testid="player-list">
            {rs.players.map((p) => (
              <li key={p.pid} className={p.pid === rs.youPid ? 'me' : ''} data-testid={`player-${p.name}`}>
                <AvatarChip avatar={p.avatar} color={p.color} />
                <span className="pname">{p.name}{p.pid === rs.youPid ? ' (you)' : ''}</span>
                {p.isHost && <span className="crown" title="Host">👑</span>}
                {!p.connected && <span className="chip warn">offline</span>}
                <span className={`chip ${p.ready || p.isHost ? 'ok' : ''}`}>{p.isHost ? 'host' : p.ready ? 'ready' : 'not ready'}</span>
              </li>
            ))}
          </ul>
          <div className="avatar-row">
            {AVATARS.map((a) => (
              <button key={a} className={`avatar-btn small ${me?.avatar === a ? 'sel' : ''}`} onClick={() => me && void act(C2S.profile, { name: me.name, avatar: a satisfies Avatar })} aria-label={`avatar ${a}`}>
                <AvatarChip avatar={a} color={me?.color ?? '#2a3a66'} size={30} />
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn primary" data-testid="btn-ready" onClick={() => { audio.sfx('click'); void act(C2S.ready, { ready: !me?.ready }); }}>
              {me?.ready ? 'Unready' : 'Ready'}
            </button>
            {isHost && <button className="btn primary glow" data-testid="btn-start" disabled={!!startBlock} onClick={() => void act(C2S.start)}>Start match</button>}
          </div>
          {isHost && startBlock && <p className="hint" data-testid="start-hint">{startBlock}</p>}
          {!isHost && <p className="hint">Waiting for the host to start…</p>}
          {error && <div className="banner error" role="alert" data-testid="error">{error}</div>}
        </section>

        <section className="glass">
          <h4>Environment {isHost ? '' : '(host chooses)'}</h4>
          <div className="env-cards">
            {(['random', ...ENVIRONMENTS] as const).map((e) => {
              const m = e === 'random' ? null : MAPS[e];
              return (
                <button key={e} disabled={!isHost} className={`env-card ${st.environment === e ? 'sel' : ''}`} data-testid={`env-${e}`}
                  style={m ? { background: `linear-gradient(135deg, ${m.palette.floor}, ${m.palette.bg})`, borderColor: m.palette.accent } : undefined}
                  onClick={() => setSetting({ environment: e })}>
                  <b style={{ color: m?.palette.accent }}>{m ? m.name : '🎲 Random'}</b>
                  <small>{m ? m.tagline : 'A surprise environment each match.'}</small>
                </button>
              );
            })}
          </div>
          <select className="input" data-testid="select-env" disabled={!isHost} value={st.environment} onChange={(e) => setSetting({ environment: e.target.value as Settings['environment'] })}>
            <option value="random">Random</option>
            {ENVIRONMENTS.map((e) => <option key={e} value={e}>{MAPS[e].name}</option>)}
          </select>
          <div className="settings">
            <Slider label="Match length" unit="min" min={LIMITS.matchMinutesMin} max={LIMITS.matchMinutesMax} value={st.matchMinutes} disabled={!isHost} onChange={(v) => setSetting({ matchMinutes: v })} />
            <Slider label="Mission threshold" unit="%" min={LIMITS.thresholdMin} max={LIMITS.thresholdMax} step={5} value={st.missionThreshold} disabled={!isHost} onChange={(v) => setSetting({ missionThreshold: v })} />
            <Slider label="Tasks per player" unit="" min={LIMITS.tasksPerPlayerMin} max={LIMITS.tasksPerPlayerMax} value={st.tasksPerPlayer} disabled={!isHost} onChange={(v) => setSetting({ tasksPerPlayer: v })} />
            <label className="toggle"><input type="checkbox" data-testid="toggle-public" checked={st.isPublic} disabled={!isHost} onChange={(e) => setSetting({ isPublic: e.target.checked })} /> Public room (listed in matchmaking)</label>
          </div>
          <h4>Room chat</h4>
          <ChatBox channels={['room', 'system']} placeholder="Say something…" />
        </section>
      </div>
    </div>
  );
}

function Slider(p: { label: string; unit: string; min: number; max: number; step?: number; value: number; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <label className="slider-row">
      <span>{p.label}: <b>{p.value}{p.unit}</b></span>
      <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}
