import { useEffect, useState } from 'react';
import { startSession, useStore } from './net/socket';
import { audio } from './audio';
import { Title } from './screens/Title';
import { Landing } from './screens/Landing';
import { Lobby } from './screens/Lobby';
import { Game } from './screens/Game';
import { Toasts } from './screens/components';

let started = false;

export function App() {
  const roomState = useStore((s) => s.roomState);
  const [entered, setEntered] = useState(() => new URLSearchParams(location.search).has('room') || sessionStorageGet('entered') === '1');

  useEffect(() => {
    if (started) return;
    started = true;
    if (new URLSearchParams(location.search).has('touch')) document.documentElement.classList.add('force-touch');
    void startSession();
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }, []);

  const enter = () => { sessionStorageSet('entered', '1'); setEntered(true); };
  let screen;
  if (roomState && (roomState.phase === 'playing' || roomState.phase === 'ended')) screen = <Game />;
  else if (roomState) screen = <Lobby />;
  else if (!entered) screen = <Title onEnter={enter} />;
  else screen = <Landing />;
  return <>{screen}<Toasts /></>;
}

function sessionStorageGet(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }
