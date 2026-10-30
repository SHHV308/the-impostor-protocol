import { useEffect, useRef } from 'react';
import { audio } from '../audio';

/** Animated cinematic title: parallax starfield canvas + glitch logo. */
export function Title({ onEnter }: { onEnter: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext('2d')!;
    const stars = Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() * 0.9 + 0.1 }));
    let raf = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const w = (c.width = c.clientWidth), h = (c.height = c.clientHeight);
      ctx.fillStyle = '#03050f'; ctx.fillRect(0, 0, w, h);
      const g = ctx.createRadialGradient(w * 0.7, h * 0.3, 0, w * 0.7, h * 0.3, w * 0.7);
      g.addColorStop(0, 'rgba(34,211,238,0.14)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (const s of stars) {
        s.x -= 0.0003 * s.z; if (s.x < 0) s.x = 1;
        ctx.fillStyle = `rgba(190,230,255,${0.3 + s.z * 0.7})`;
        ctx.fillRect(s.x * w, s.y * h + Math.sin(t / 1500 + s.y * 9) * 2, s.z * 2.2, s.z * 2.2);
      }
      // drifting silhouette ship
      const sx = ((t / 40) % (w + 400)) - 200;
      ctx.fillStyle = 'rgba(20,40,80,0.8)'; ctx.beginPath(); ctx.moveTo(sx, h * 0.72); ctx.lineTo(sx + 90, h * 0.7); ctx.lineTo(sx + 130, h * 0.72); ctx.lineTo(sx + 90, h * 0.74); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(34,211,238,0.9)'; ctx.fillRect(sx + 118, h * 0.717, 5, 3);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="title-screen">
      <canvas ref={ref} className="title-canvas" />
      <div className="title-content">
        <p className="eyebrow">TRUST NO ONE</p>
        <h1 className="glitch" data-text="THE IMPOSTOR PROTOCOL">THE IMPOSTOR PROTOCOL</h1>
        <p className="tagline">Complete the missions. Survive the sabotage. Find the impostor.</p>
        <button className="btn primary big pulse" data-testid="btn-enter" onClick={() => { audio.unlock(); audio.sfx('reveal'); onEnter(); }}>ENTER</button>
      </div>
    </div>
  );
}
