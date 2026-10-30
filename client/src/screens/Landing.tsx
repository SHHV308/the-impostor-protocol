import { useEffect, useState } from 'react';
import {
  AVATARS, ACHIEVEMENTS, C2S, levelFromXp, nameSchema, roomCodeSchema,
  type Avatar, type LeaderboardEntry,
} from '@impostor/shared';
import { audio } from '../audio';
import { clearClosed, emit, fetchHistory, fetchLeaderboard, refreshProfile, saveProfile, useStore } from '../net/socket';
import { AvatarChip, SoundControl } from './components';

const KEY = 'impostor.identity';
function loadIdentity(): { name?: string; avatar?: Avatar } {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}

export function Landing() {
  const profile = useStore((s) => s.profile);
  const connected = useStore((s) => s.connected);
  const closed = useStore((s) => s.closedReason);
  const saved = loadIdentity();
  const urlCode = new URLSearchParams(location.search).get('room') ?? '';
  const [name, setName] = useState(saved.name ?? '');
  const [avatar, setAvatar] = useState<Avatar>(saved.avatar ?? 'visor');
  const [code, setCode] = useState(urlCode.toUpperCase());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(false);

  useEffect(() => { if (!name && profile?.displayName) setName(profile.displayName); }, [profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const validName = () => {
    const r = nameSchema.safeParse(name);
    if (!r.success) { setError(r.error.issues[0]?.message ?? 'Invalid name'); return null; }
    try { localStorage.setItem(KEY, JSON.stringify({ name: r.data, avatar })); } catch { /* ignore */ }
    return r.data;
  };

  const run = async (fn: (n: string) => Promise<{ ok: boolean; error?: string }>) => {
    setError(''); clearClosed();
    const n = validName(); if (!n) return;
    audio.unlock(); audio.sfx('click'); setBusy(true);
    void saveProfile(n, avatar);
    const res = await fn(n);
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'Something went wrong');
    else if (urlCode) history.replaceState(null, '', location.pathname);
  };

  return (
    <div className="landing">
      <div className="topbar"><span className="logo-sm">THE IMPOSTOR PROTOCOL</span><SoundControl /></div>
      <div className="landing-card glass">
        <h2>Join the crew</h2>
        {!connected && <div className="banner warn" data-testid="banner-offline">Connecting to server…</div>}
        {closed && <div className="banner warn">{closed}</div>}
        <label className="field">Callsign
          <input className="input" data-testid="input-name" value={name} maxLength={16} placeholder="Guest name"
            onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">Avatar
          <div className="avatar-grid">
            {AVATARS.map((a) => (
              <button key={a} data-testid={`avatar-${a}`} className={`avatar-btn ${a === avatar ? 'sel' : ''}`} onClick={() => { setAvatar(a); audio.sfx('click'); }} aria-label={a}>
                <AvatarChip avatar={a} color="#2a3a66" size={44} />
              </button>
            ))}
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" data-testid="btn-create" disabled={busy || !connected}
            onClick={() => run((n) => emit<{ code: string }>(C2S.createRoom, { name: n, avatar, isPublic: false }))}>Create private room</button>
          <button className="btn" data-testid="btn-matchmake" disabled={busy || !connected}
            onClick={() => run((n) => emit(C2S.matchmake, { name: n, avatar }))}>Public matchmaking</button>
        </div>
        <div className="join-row">
          <input className="input mono" data-testid="input-code" value={code} maxLength={6} placeholder="ROOM CODE"
            onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button className="btn" data-testid="btn-join" disabled={busy || !connected} onClick={() => {
            const r = roomCodeSchema.safeParse(code);
            if (!r.success) { setError('Enter a valid 6-character room code'); return; }
            void run((n) => emit(C2S.joinRoom, { code: r.data, name: n, avatar }));
          }}>Join</button>
        </div>
        {error && <div className="banner error" role="alert" data-testid="error">{error}</div>}
        <button className="btn ghost" data-testid="btn-profile" onClick={() => { setPanel(true); void refreshProfile(); }}>
          Profile & leaderboard{profile ? ` · Lv ${profile.level} · ${profile.xp} XP` : ''}
        </button>
      </div>
      <footer className="site-foot">A project by SHHV308</footer>
      {panel && <ProfilePanel onClose={() => setPanel(false)} />}
    </div>
  );
}

function ProfilePanel({ onClose }: { onClose: () => void }) {
  const profile = useStore((s) => s.profile);
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);
  const [hist, setHist] = useState<Awaited<ReturnType<typeof fetchHistory>>['matches']>([]);
  useEffect(() => {
    fetchLeaderboard().then((r) => setRows(r.entries)).catch(() => setRows([]));
    fetchHistory().then((r) => setHist(r.matches)).catch(() => setHist([]));
  }, []);
  const unlocked = new Set(profile?.achievements.map((a) => a.key));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass wide" onClick={(e) => e.stopPropagation()} data-testid="profile-panel">
        <header><h3>Your profile</h3><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></header>
        {profile && (
          <div className="profile-grid">
            <div><b>{profile.displayName}</b><br />Level {levelFromXp(profile.xp)} · {profile.xp} XP<br />{profile.gamesPlayed} games · {profile.wins} wins</div>
            <div className="ach">
              {Object.entries(ACHIEVEMENTS).map(([k, a]) => (
                <span key={k} className={`ach-badge ${unlocked.has(k) ? 'on' : ''}`} title={a.description}>{a.title}</span>
              ))}
            </div>
          </div>
        )}
        <h4>Leaderboard</h4>
        <ol className="leaderboard" data-testid="leaderboard">
          {rows === null && <li>Loading…</li>}
          {rows?.length === 0 && <li>No players ranked yet.</li>}
          {rows?.map((r) => <li key={r.rank}><span>#{r.rank}</span><AvatarChip avatar={r.avatar} color="#2a3a66" size={24} /><b>{r.displayName}</b><span>{r.xp} XP · {r.wins}W/{r.gamesPlayed}</span></li>)}
        </ol>
        <h4>Recent matches</h4>
        <ul className="history">
          {hist.length === 0 && <li>No matches yet.</li>}
          {hist.map((m, i) => <li key={i}>{m.won ? '🏆' : '💀'} {m.environment} · {m.role} · +{m.xpEarned} XP</li>)}
        </ul>
      </div>
    </div>
  );
}
