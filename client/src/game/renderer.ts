import {
  MAPS, PLAYER_RADIUS, RANGES, WORLD_H, WORLD_W, stepMove,
  type EnvironmentId, type GameSnapshot, type MapDef, type PublicPlayer, type Rect,
} from '@impostor/shared';
import { getState, serverNow, snapshotBuffer } from '../net/socket';
import { live } from './live';

const RES = 1.5;
const INTERP_DELAY = 110;
const mapCache = new Map<EnvironmentId, HTMLCanvasElement>();

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ------------------------------------------------------------ static map art
function buildMap(map: MapDef): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = WORLD_W * RES; c.height = WORLD_H * RES;
  const ctx = c.getContext('2d')!;
  ctx.scale(RES, RES);
  const p = map.palette;
  const rand = rng(map.id.length * 7919 + map.rooms.length);
  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  if (map.id === 'space') { // starfield beyond the hull
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(200,235,255,${0.2 + rand() * 0.7})`;
      const s = rand() * 1.8 + 0.4; ctx.fillRect(rand() * WORLD_W, rand() * WORLD_H, s, s);
    }
  } else if (map.id === 'bunker') {
    for (let i = 0; i < 900; i++) { ctx.fillStyle = `rgba(0,0,0,${rand() * 0.3})`; ctx.fillRect(rand() * WORLD_W, rand() * WORLD_H, 3, 3); }
  }

  const rects: Rect[] = [...map.rooms, ...map.corridors];
  ctx.shadowColor = p.wall; ctx.shadowBlur = 22; ctx.fillStyle = p.wall;
  for (const r of rects) ctx.fillRect(r.x - 8, r.y - 8, r.w + 16, r.h + 16);
  ctx.shadowBlur = 0; ctx.fillStyle = p.floor;
  for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);

  ctx.save();
  ctx.beginPath(); for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  floorPattern(ctx, map, rand);
  ctx.restore();

  // per-room tint, label and accent corners
  map.rooms.forEach((r, i) => {
    ctx.fillStyle = rgba(i % 2 ? p.accent : p.accent2, 0.05); ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = rgba(p.accent, 0.35); ctx.lineWidth = 2; ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
    ctx.fillStyle = rgba(p.accent, 0.6); ctx.font = '700 13px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(r.name.toUpperCase(), r.x + 14, r.y + 24);
    if (map.id === 'bunker') hazardBand(ctx, r.x + 4, r.y + r.h - 12, r.w - 8, 8);
  });
  map.obstacles.forEach((o, i) => drawProp(ctx, map, o, i));
  return c;
}

function hazardBand(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#e0a21b'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#1b1610'; ctx.lineWidth = 6;
  for (let i = -h; i < w; i += 16) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); ctx.stroke(); }
  ctx.restore();
}

function floorPattern(ctx: CanvasRenderingContext2D, map: MapDef, rand: () => number) {
  const p = map.palette;
  ctx.lineWidth = 1;
  if (map.id === 'space') {
    ctx.strokeStyle = rgba(p.accent, 0.08);
    for (let x = 0; x < WORLD_W; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); ctx.stroke(); }
    for (let y = 0; y < WORLD_H; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); ctx.stroke(); }
    ctx.fillStyle = rgba(p.accent, 0.25);
    for (let x = 0; x < WORLD_W; x += 100) for (let y = 0; y < WORLD_H; y += 100) ctx.fillRect(x - 1, y - 1, 3, 3);
  } else if (map.id === 'lab') {
    const s = 24, h = s * Math.sqrt(3);
    ctx.strokeStyle = rgba(p.accent2, 0.16);
    for (let row = 0; row * h * 0.5 < WORLD_H + h; row++) {
      for (let col = 0; col * s * 3 < WORLD_W + s * 3; col++) {
        const cx = col * s * 3 + (row % 2 ? s * 1.5 : 0), cy = row * h * 0.5;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k; ctx.lineTo(cx + s * Math.cos(a), cy + s * Math.sin(a)); }
        ctx.closePath(); ctx.stroke();
      }
    }
  } else if (map.id === 'cyber') {
    ctx.strokeStyle = rgba(p.accent, 0.07);
    for (let x = 0; x < WORLD_W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); ctx.stroke(); }
    for (let y = 0; y < WORLD_H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); ctx.stroke(); }
    ctx.lineWidth = 2;
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(rand() * 40) * 40, y = Math.floor(rand() * 25) * 40, len = (1 + Math.floor(rand() * 4)) * 40;
      ctx.strokeStyle = rgba(rand() > 0.5 ? p.accent : p.accent2, 0.28);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y + 40); ctx.stroke();
      ctx.fillStyle = rgba(p.accent2, 0.5); ctx.beginPath(); ctx.arc(x + len, y + 40, 3, 0, 6.3); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let y = 0; y < WORLD_H; y += 4) ctx.fillRect(0, y, WORLD_W, 1);
  } else {
    for (let i = 0; i < 3500; i++) { ctx.fillStyle = `rgba(${rand() > 0.5 ? '255,235,200' : '0,0,0'},${rand() * 0.07})`; ctx.fillRect(rand() * WORLD_W, rand() * WORLD_H, 2 + rand() * 3, 2 + rand() * 3); }
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 2;
    for (let x = 0; x < WORLD_W; x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); ctx.stroke(); }
    for (let y = 0; y < WORLD_H; y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); ctx.stroke(); }
  }
}

function drawProp(ctx: CanvasRenderingContext2D, map: MapDef, o: Rect, i: number) {
  const p = map.palette;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
  if (map.id === 'space') {
    ctx.fillStyle = '#0a1a33'; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.shadowBlur = 0; ctx.strokeStyle = p.accent; ctx.lineWidth = 2; ctx.strokeRect(o.x, o.y, o.w, o.h);
    const g = ctx.createLinearGradient(o.x, o.y, o.x + o.w, o.y); g.addColorStop(0, rgba(p.accent, 0.8)); g.addColorStop(1, rgba(p.accent2, 0.8));
    ctx.fillStyle = g; ctx.fillRect(o.x + 6, o.y + 6, o.w - 12, 14);
    ctx.fillStyle = rgba(p.accent, 0.5); for (let k = 0; k < 5; k++) ctx.fillRect(o.x + 8 + k * 12, o.y + 28, 8, 10);
  } else if (map.id === 'lab') {
    ctx.fillStyle = '#d7d2e6'; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 8); ctx.fill();
    ctx.shadowBlur = 0;
    ['#a3e635', '#a855f7', '#22d3ee'].forEach((col, k) => {
      const bx = o.x + 14 + k * 20, by = o.y + 24;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, 7, 0, 6.3); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(bx - 2, by - 17, 4, 11);
    });
  } else if (map.id === 'cyber') {
    ctx.fillStyle = '#0b1030'; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.shadowBlur = 0; ctx.strokeStyle = p.accent2; ctx.lineWidth = 2; ctx.strokeRect(o.x, o.y, o.w, o.h);
    const r = rng(i + 3);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 7; col++) {
      ctx.fillStyle = r() > 0.8 ? p.danger : r() > 0.5 ? p.accent : p.accent2; ctx.fillRect(o.x + 6 + col * 9, o.y + 6 + row * 10, 5, 4);
    }
  } else {
    ctx.fillStyle = '#7a5a2e'; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.shadowBlur = 0; ctx.strokeStyle = '#3d2c14'; ctx.lineWidth = 3; ctx.strokeRect(o.x, o.y, o.w, o.h);
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + o.w, o.y + o.h); ctx.moveTo(o.x + o.w, o.y); ctx.lineTo(o.x, o.y + o.h); ctx.stroke();
    ctx.fillStyle = '#c9a35a'; [[4, 4], [o.w - 8, 4], [4, o.h - 8], [o.w - 8, o.h - 8]].forEach(([dx, dy]) => ctx.fillRect(o.x + dx!, o.y + dy!, 4, 4));
  }
  ctx.restore();
}

// ------------------------------------------------------------ dynamic drawing
interface DrawPlayer extends PublicPlayer { rx: number; ry: number }

function interpolate(s: GameSnapshot): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const t = serverNow() - INTERP_DELAY;
  const buf = snapshotBuffer;
  let a: GameSnapshot | null = null, b: GameSnapshot | null = null;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i]!.now <= t) { a = buf[i]!; b = buf[i + 1] ?? null; break; }
  }
  if (!a) a = buf[0] ?? s;
  const k = b && b.now > a.now ? Math.min(1, (t - a.now) / (b.now - a.now)) : 0;
  const bm = new Map((b?.players ?? []).map((p) => [p.pid, p]));
  for (const p of s.players) {
    const pa = a.players.find((q) => q.pid === p.pid), pb = bm.get(p.pid);
    if (pa && pb) out.set(p.pid, { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k });
    else out.set(p.pid, { x: (pa ?? p).x, y: (pa ?? p).y });
  }
  return out;
}

export function sealedRects(s: GameSnapshot | null): Rect[] {
  const id = s?.sabotage?.sealedRoom;
  if (!s || !id) return [];
  const r = MAPS[s.env].rooms.find((x) => x.id === id);
  return r ? [r] : [];
}

export class GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private last = performance.now();
  private raf = 0;
  private w = 0; private h = 0; private dpr = 1;
  private noise = (() => { const n = document.createElement('canvas'); n.width = n.height = 128; const x = n.getContext('2d')!; const d = x.createImageData(128, 128); for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } x.putImageData(d, 0, 0); return n; })();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const loop = (t: number) => { this.raf = requestAnimationFrame(loop); this.frame(t); };
    this.raf = requestAnimationFrame(loop);
  }
  destroy() { cancelAnimationFrame(this.raf); }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.floor(w * dpr)); this.canvas.height = Math.max(1, Math.floor(h * dpr));
    }
  }

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.resize();
    const s = getState().snapshot;
    const ctx = this.ctx;
    if (!s) { ctx.fillStyle = '#050816'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); return; }
    const map = MAPS[s.env];
    let bg = mapCache.get(s.env);
    if (!bg) { bg = buildMap(map); mapCache.set(s.env, bg); }

    // --- movement prediction / reconciliation
    const myPid = s.you.pid;
    const serverMe = s.players.find((p) => p.pid === myPid);
    const canMove = s.you.alive && s.phase === 'playing' && serverNow() >= s.frozenUntil;
    if (serverMe) {
      if (!live.me.init || Math.hypot(serverMe.x - live.me.x, serverMe.y - live.me.y) > 60 || !canMove) {
        live.me.x = serverMe.x; live.me.y = serverMe.y; live.me.init = true;
      }
      if (canMove) {
        const moving = Math.hypot(live.intent.x, live.intent.y) > 0.01;
        const np = stepMove(map, live.me, live.intent, dt, sealedRects(s));
        const f = moving ? 0.03 : 0.2;
        live.me.x = np.x + (serverMe.x - np.x) * f; live.me.y = np.y + (serverMe.y - np.y) * f;
      }
    }

    const pos = interpolate(s);
    const players: DrawPlayer[] = s.players.map((p) => {
      const q = p.pid === myPid && s.you.alive ? live.me : pos.get(p.pid)!;
      return { ...p, rx: q.x, ry: q.y };
    });

    // --- camera
    let cam = { x: live.me.x, y: live.me.y };
    if (!s.you.alive) {
      let f = players.find((p) => p.pid === live.followPid && p.alive);
      if (!f) { f = players.find((p) => p.alive && p.pid !== myPid); live.followPid = f?.pid ?? null; }
      if (f) cam = { x: f.rx, y: f.ry };
    }
    const viewW = this.w < 600 ? 520 : 820;
    const scale = Math.max(0.3, Math.min(this.w / viewW, this.h / (viewW * 0.68))) * this.dpr;
    const t = now / 1000;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = map.palette.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale, 0, 0, scale, this.canvas.width / 2 - cam.x * scale, this.canvas.height / 2 - cam.y * scale);
    ctx.drawImage(bg, 0, 0, WORLD_W, WORLD_H);

    this.drawSabotageWorld(s, map, t);
    this.drawStations(s, map, t);
    this.drawBodies(s, t);
    const vis = [...players].sort((a, b) => a.ry - b.ry);
    for (const p of vis) {
      if (!p.alive && s.you.alive) continue; // ghosts only visible to spectators
      this.drawPlayer(p, t, p.pid === myPid, s);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawScreenFx(s, map, scale, cam, t);
  }

  private drawSabotageWorld(s: GameSnapshot, map: MapDef, t: number) {
    const ctx = this.ctx, sab = s.sabotage;
    if (!sab) return;
    if (sab.sealedRoom) {
      const r = map.rooms.find((x) => x.id === sab.sealedRoom);
      if (r) {
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
        ctx.fillStyle = `rgba(255,40,70,${0.14 + Math.sin(t * 5) * 0.05})`; ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = 'rgba(255,60,80,0.35)'; ctx.lineWidth = 6;
        for (let i = -r.h; i < r.w; i += 28) { ctx.beginPath(); ctx.moveTo(r.x + i, r.y + r.h); ctx.lineTo(r.x + i + r.h, r.y); ctx.stroke(); }
        ctx.restore();
        ctx.strokeStyle = '#ff3b57'; ctx.lineWidth = 5; ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.font = '700 22px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff6b81';
        ctx.fillText('SEALED', r.x + r.w / 2, r.y + 60);
      }
    }
    for (const tr of sab.traps ?? []) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 6);
      const g = ctx.createRadialGradient(tr.x, tr.y, 4, tr.x, tr.y, tr.r);
      g.addColorStop(0, `rgba(255,60,60,${0.6 + pulse * 0.3})`); g.addColorStop(1, 'rgba(255,60,60,0.08)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.r, 0, 6.3); ctx.fill();
      ctx.strokeStyle = '#ff8a8a'; ctx.setLineDash([8, 6]); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.r, 0, 6.3); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '700 26px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText('⚠', tr.x, tr.y + 9);
    }
  }

  private drawStations(s: GameSnapshot, map: MapDef, t: number) {
    const ctx = this.ctx, p = map.palette;
    const tasks = new Map(s.you.tasks.map((k) => [k.missionId, k]));
    const near = (x: number, y: number) => Math.hypot(x - live.me.x, y - live.me.y) < RANGES.interact;
    const sabStations = new Map((s.sabotage?.stations ?? []).map((st) => [st.id, st]));
    ctx.textAlign = 'center';
    for (const st of map.stations) {
      ctx.save(); ctx.translate(st.x, st.y);
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 + st.x);
      if (st.type === 'mission') {
        const task = tasks.get(st.missionId ?? '');
        if (task && !task.done) {
          ctx.shadowColor = '#ffd84d'; ctx.shadowBlur = 14 + pulse * 10;
          ctx.fillStyle = '#ffd84d'; ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(12, 0); ctx.lineTo(0, 14); ctx.lineTo(-12, 0); ctx.closePath(); ctx.fill();
          ctx.shadowBlur = 0; ctx.fillStyle = '#10131f'; ctx.font = '700 13px system-ui'; ctx.fillText('!', 0, 5);
        } else if (task?.done) {
          ctx.fillStyle = 'rgba(80,255,150,0.7)'; ctx.font = '700 18px system-ui'; ctx.fillText('✓', 0, 6);
        } else {
          ctx.fillStyle = rgba(p.accent, 0.35); ctx.beginPath(); ctx.arc(0, 0, 7, 0, 6.3); ctx.fill();
        }
        if (task && !task.done && near(st.x, st.y)) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 22, 0, 6.3); ctx.stroke(); }
      } else if (st.type === 'repair') {
        const sab = sabStations.get(st.id);
        if (sab && !sab.fixed) {
          ctx.shadowColor = '#ff3355'; ctx.shadowBlur = 12 + pulse * 14; ctx.fillStyle = `rgba(255,${50 + pulse * 60},70,1)`;
          ctx.fillRect(-14, -14, 28, 28); ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = '700 18px system-ui'; ctx.fillText('🔧', 0, 7);
        } else if (sab) {
          ctx.fillStyle = '#35e08a'; ctx.fillRect(-12, -12, 24, 24);
        } else {
          ctx.fillStyle = 'rgba(160,170,190,0.25)'; ctx.fillRect(-9, -9, 18, 18);
        }
      } else if (st.type === 'emergency') {
        ctx.shadowColor = '#ff2d55'; ctx.shadowBlur = 10 + pulse * 10;
        ctx.fillStyle = '#7a0f22'; ctx.beginPath(); ctx.arc(0, 0, 17, 0, 6.3); ctx.fill();
        ctx.fillStyle = '#ff2d55'; ctx.beginPath(); ctx.arc(0, -2, 12, 0, 6.3); ctx.fill();
      } else {
        ctx.fillStyle = '#0a1226'; ctx.strokeStyle = p.accent; ctx.lineWidth = 2; ctx.fillRect(-16, -12, 32, 24); ctx.strokeRect(-16, -12, 32, 24);
        ctx.fillStyle = rgba(p.accent, 0.4 + pulse * 0.4); ctx.fillRect(-12, -8, 24, 14);
      }
      ctx.restore();
    }
  }

  private drawBodies(s: GameSnapshot, t: number) {
    const ctx = this.ctx;
    for (const b of s.bodies) {
      ctx.save(); ctx.translate(b.x, b.y);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(0, 8, 18, 6, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = b.color; ctx.beginPath(); ctx.ellipse(0, 2, 17, 10, 0.2, 0, Math.PI); ctx.fill();
      ctx.fillStyle = '#e8f6ff'; ctx.beginPath(); ctx.arc(-9, -3, 5, 0, 6.3); ctx.fill();
      ctx.strokeStyle = `rgba(255,70,90,${0.5 + 0.5 * Math.sin(t * 5)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 24, 0, 6.3); ctx.stroke();
      ctx.restore();
    }
  }

  private drawPlayer(p: DrawPlayer, t: number, me: boolean, s: GameSnapshot) {
    const ctx = this.ctx, r = PLAYER_RADIUS;
    const ghost = !p.alive;
    const walking = p.anim === 'walk' || (me && Math.hypot(live.intent.x, live.intent.y) > 0.01);
    const bob = walking ? Math.sin(t * 14 + p.rx * 0.1) * 2 : Math.sin(t * 2) * 0.6;
    const dir = me && Math.abs(live.intent.x) > 0.1 ? (live.intent.x > 0 ? 1 : -1) : p.dir;
    ctx.save(); ctx.translate(p.rx, p.ry);
    ctx.globalAlpha = ghost ? 0.38 : 1;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0, r - 2, r, 5, 0, 0, 6.3); ctx.fill();
    if (p.protectedFx && !ghost) {
      ctx.strokeStyle = `rgba(80,255,180,${0.5 + 0.4 * Math.sin(t * 6)})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, r + 8, 0, 6.3); ctx.stroke();
    }
    ctx.translate(0, ghost ? Math.sin(t * 2 + p.rx) * 4 - 4 : bob);
    // legs
    if (!ghost) {
      const sw = walking ? Math.sin(t * 14) * 4 : 0;
      ctx.fillStyle = shade(p.color, -40);
      ctx.fillRect(-9 + sw, r - 5, 7, 7); ctx.fillRect(2 - sw, r - 5, 7, 7);
    }
    // torso
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.roundRect(-r, -r - 2, r * 2, r * 2 + 2, 10); ctx.fill();
    ctx.strokeStyle = shade(p.color, -50); ctx.lineWidth = 2; ctx.stroke();
    // visor
    ctx.fillStyle = '#d9f3ff'; ctx.beginPath(); ctx.roundRect(dir > 0 ? -2 : -r + 2, -r + 2, r + 2, 11, 5); ctx.fill();
    ctx.fillStyle = 'rgba(40,120,200,0.55)'; ctx.fillRect(dir > 0 ? 3 : -r + 6, -r + 4, 4, 4);
    this.accessory(p.avatar, r, t, dir);
    ctx.restore();

    if (p.anim === 'channel' && !ghost) {
      ctx.save(); ctx.translate(p.rx, p.ry - r - 24); ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 7, t * 6, t * 6 + 4); ctx.stroke(); ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = ghost ? 0.5 : 1;
    ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(p.name, p.rx, p.ry - r - 8);
    ctx.fillStyle = me ? '#7dffe0' : '#fff'; ctx.fillText(p.name, p.rx, p.ry - r - 8);
    if (s.you.mates.some((m) => m.pid === p.pid) && !me) { ctx.fillStyle = '#ff4d6d'; ctx.fillText('▼', p.rx, p.ry - r - 20); }
    ctx.restore();
  }

  private accessory(a: string, r: number, t: number, dir: number) {
    const ctx = this.ctx; ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    switch (a) {
      case 'antenna': ctx.beginPath(); ctx.moveTo(0, -r - 2); ctx.lineTo(0, -r - 11); ctx.stroke(); ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.arc(0, -r - 13, 3, 0, 6.3); ctx.fill(); break;
      case 'helmet': ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(0, -3, r + 2, Math.PI, 0); ctx.stroke(); break;
      case 'goggles': ctx.strokeStyle = '#222'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(-6, -r + 7, 5, 0, 6.3); ctx.arc(6, -r + 7, 5, 0, 6.3); ctx.stroke(); break;
      case 'hood': ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(0, -r - 12); ctx.lineTo(r, -r); ctx.closePath(); ctx.fill(); break;
      case 'crest': ctx.fillStyle = '#ffcc33'; ctx.beginPath(); ctx.moveTo(-6 * dir, -r - 2); ctx.lineTo(0, -r - 14); ctx.lineTo(6 * dir, -r - 2); ctx.closePath(); ctx.fill(); break;
      case 'halo': ctx.strokeStyle = '#ffe27a'; ctx.beginPath(); ctx.ellipse(0, -r - 8 + Math.sin(t * 3), 9, 3, 0, 0, 6.3); ctx.stroke(); break;
      case 'bolt': ctx.fillStyle = '#ffe14d'; ctx.beginPath(); ctx.moveTo(1, 2); ctx.lineTo(-5, 10); ctx.lineTo(-1, 10); ctx.lineTo(-3, 17); ctx.lineTo(5, 7); ctx.lineTo(1, 7); ctx.closePath(); ctx.fill(); break;
      default: ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(-r + 2, -r + 14, r * 2 - 4, 2); break; // visor: stripe
    }
    ctx.restore();
  }

  private drawScreenFx(s: GameSnapshot, map: MapDef, scale: number, cam: { x: number; y: number }, t: number) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2 + (live.me.x - cam.x) * scale, cy = H / 2 + (live.me.y - cam.y) * scale;
    if (s.lightsOut && s.you.faction !== 'impostor') {
      const r = RANGES.lightsOutVision * scale;
      const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(2,3,10,0.97)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(2,3,10,0.97)';
      ctx.fillRect(0, 0, W, Math.max(0, cy - r)); ctx.fillRect(0, cy + r, W, H);
      ctx.fillRect(0, 0, Math.max(0, cx - r), H); ctx.fillRect(cx + r, 0, W, H);
    } else if (s.lightsOut) {
      ctx.fillStyle = 'rgba(2,3,10,0.35)'; ctx.fillRect(0, 0, W, H);
    }
    if (s.commsBlackout) {
      ctx.save(); ctx.globalAlpha = 0.09; ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(this.noise, (t * 700) % 128, (t * 300) % 128, 128, 128, 0, 0, W, H); ctx.restore();
    }
    if (s.sabotage) {
      const crit = s.sabotage.critical;
      const a = (crit ? 0.25 : 0.12) + 0.12 * Math.sin(t * (crit ? 8 : 4));
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(255,0,40,0)'); g.addColorStop(1, `rgba(255,0,40,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (!s.you.alive) { ctx.fillStyle = 'rgba(120,140,255,0.07)'; ctx.fillRect(0, 0, W, H); }
    void map;
  }
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
