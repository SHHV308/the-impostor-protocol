import { useEffect, useRef, useState } from 'react';
import { C2S, type GameSnapshot } from '@impostor/shared';
import { audio } from '../audio';
import { emit, pushToast, serverNow } from '../net/socket';
import { AvatarChip, ChatBox, useNow } from './components';

export function Meeting({ snap }: { snap: GameSnapshot }) {
  useNow(200);
  const m = snap.meeting!;
  const you = snap.you;
  const [intro, setIntro] = useState(true);
  const [pending, setPending] = useState(false);
  const lastTick = useRef(-1);

  useEffect(() => { setIntro(true); const t = setTimeout(() => setIntro(false), 2200); return () => clearTimeout(t); }, []);

  const left = Math.max(0, m.endsAt - serverNow());
  const secs = Math.ceil(left / 1000);
  useEffect(() => {
    if (m.phase === 'voting' && secs <= 10 && secs > 0 && lastTick.current !== secs) { lastTick.current = secs; audio.sfx('tick'); }
  }, [secs, m.phase]);

  const iVoted = m.voted.includes(you.pid);
  const canVote = you.alive && m.phase === 'voting' && !iVoted && !pending;
  const vote = async (target: string) => {
    setPending(true);
    const r = await emit(C2S.vote, { target });
    setPending(false);
    if (!r.ok) pushToast(r.error, 'bad'); else audio.sfx('vote');
  };
  const nameOf = (pid: string) => snap.players.find((p) => p.pid === pid)?.name ?? '???';
  const res = m.results;
  const caller = nameOf(m.callerPid);

  return (
    <div className="meeting" data-testid="meeting-panel">
      {intro && (
        <div className={`meeting-intro ${m.reason}`} data-testid="meeting-intro">
          <h2>{m.reason === 'body' ? 'BODY REPORTED' : 'EMERGENCY MEETING'}</h2>
          <p>{m.reason === 'body' ? `${caller} found ${m.bodyName ?? 'a body'}` : `Called by ${caller}`}</p>
        </div>
      )}
      <div className="meeting-main glass">
        <header>
          <h3>{m.phase === 'discussion' ? 'Discussion' : m.phase === 'voting' ? 'Vote' : 'Results'}</h3>
          <span className={`countdown ${secs <= 10 && m.phase === 'voting' ? 'urgent' : ''}`} data-testid="meeting-timer">{secs}s</span>
        </header>
        {!you.alive && <div className="banner warn" data-testid="meeting-spectator">You are eliminated: you can watch but not vote.</div>}
        {m.phase === 'discussion' && you.alive && <p className="hint">Discuss. Voting opens when the timer ends.</p>}
        {m.phase === 'voting' && iVoted && <p className="hint" data-testid="voted-note">Vote locked in. Waiting for results…</p>}

        <div className="vote-grid">
          {snap.players.map((p) => {
            const count = res?.tally[p.pid] ?? 0;
            const voters = res?.votes.filter((v) => v.target === p.pid).map((v) => nameOf(v.voter)) ?? [];
            const ejected = res?.ejected === p.pid;
            return (
              <div key={p.pid} className={`vote-card ${p.alive ? '' : 'dead'} ${ejected ? 'ejected' : ''}`} data-testid={`player-card-${p.pid}`}>
                <AvatarChip avatar={p.avatar} color={p.color} size={44} />
                <b>{p.name}</b>
                {!p.alive && <small>eliminated</small>}
                {m.voted.includes(p.pid) && m.phase !== 'results' && <span className="voted-badge" title="has voted">✔</span>}
                {res && <span className="tally" data-testid={`tally-${p.pid}`}>{count}</span>}
                {res && voters.length > 0 && <small className="voters">{voters.join(', ')}</small>}
                {p.alive && m.phase === 'voting' && (
                  <button className="btn small" data-testid={`vote-${p.pid}`} disabled={!canVote || p.pid === you.pid && false} onClick={() => void vote(p.pid)}>Vote</button>
                )}
              </div>
            );
          })}
          <div className="vote-card skip" data-testid="player-card-skip">
            <span className="skip-ico">⏭</span><b>Skip</b>
            {res && <span className="tally" data-testid="tally-skip">{res.tally.skip ?? 0}</span>}
            {m.phase === 'voting' && <button className="btn small" data-testid="vote-skip" disabled={!canVote} onClick={() => void vote('skip')}>Skip vote</button>}
          </div>
        </div>

        {res && (
          <div className="results" data-testid="meeting-results">
            {res.ejected ? <h2>{nameOf(res.ejected)} was ejected.</h2> : <h2>{res.tie ? 'Tie: nobody is ejected.' : 'Skipped: nobody is ejected.'}</h2>}
            <p>Roles stay hidden until the match ends.</p>
          </div>
        )}
      </div>
      <div className="meeting-chat glass">
        <h4>{you.alive ? 'Meeting chat' : 'Spectator chat'}</h4>
        <ChatBox channels={you.alive ? ['meeting', 'system'] : ['spectator', 'meeting', 'system']} placeholder={you.alive ? 'Make your case…' : 'Spectators only…'} disabled={m.phase === 'results'} />
      </div>
    </div>
  );
}
