import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { C2S, type Avatar, type ChatMessage } from '@impostor/shared';
import { audio } from '../audio';
import { emit, useStore } from '../net/socket';

export const AVATAR_GLYPH: Record<Avatar, string> = {
  visor: '🕶', antenna: '📡', helmet: '⛑', goggles: '🥽', hood: '🧥', crest: '👑', halo: '😇', bolt: '⚡',
};

export function AvatarChip({ avatar, color, size = 36 }: { avatar: Avatar; color: string; size?: number }) {
  return (
    <span className="avatar-chip" style={{ width: size, height: size, background: color, fontSize: size * 0.5 }}>
      {AVATAR_GLYPH[avatar] ?? '🙂'}
    </span>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

export function useNow(ms = 250) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return n;
}

export function SoundControl() {
  const prefs = useSyncExternalStore((cb) => audio.subscribe(cb), () => JSON.stringify(audio.prefs));
  const p = JSON.parse(prefs) as typeof audio.prefs;
  const [open, setOpen] = useState(false);
  return (
    <div className="sound">
      <button className="icon-btn" data-testid="btn-sound" onClick={() => { audio.unlock(); audio.toggleMute(); }} aria-label="Toggle sound">{p.muted ? '🔇' : '🔊'}</button>
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Sound settings">⚙</button>
      {open && (
        <div className="sound-pop glass">
          {(['master', 'music', 'sfx'] as const).map((k) => (
            <label key={k}>{k}<input type="range" min={0} max={1} step={0.05} value={p[k]} onChange={(e) => audio.setVolume(k, Number(e.target.value))} /></label>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatBox({ channels, placeholder, disabled }: { channels: ChatMessage['channel'][]; placeholder: string; disabled?: boolean }) {
  const chat = useStore((s) => s.chat);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const shown = chat.filter((m) => channels.includes(m.channel));
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [shown.length]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await emit(C2S.chat, { text: t });
  };
  return (
    <div className="chat" data-testid="chat">
      <div className="chat-log">
        {shown.map((m) => (
          <div key={m.id} className={`msg ${m.channel}`}>
            {m.channel === 'system' ? <em>{m.text}</em> : <><b style={{ color: m.color }}>{m.name}</b> {m.text}</>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <input className="input" data-testid="chat-input" value={text} maxLength={200} disabled={disabled} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
        <button className="btn" disabled={disabled} onClick={() => void send()}>Send</button>
      </div>
    </div>
  );
}
