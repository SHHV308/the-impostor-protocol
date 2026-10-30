// Procedural WebAudio: music, ambience and SFX are all synthesized (no asset files).
import type { EnvironmentId } from '@impostor/shared';

type Scene = EnvironmentId | 'menu';
type Sfx = 'click' | 'mission' | 'fail' | 'sabotage' | 'eliminate' | 'scream' | 'meeting' | 'tick' | 'victory' | 'defeat' | 'reveal' | 'vote';

interface Voicing { root: number; scale: number[]; wave: OscillatorType; bpm: number; drone: number }
const SCENES: Record<Scene, Voicing> = {
  menu: { root: 110, scale: [0, 3, 7, 10, 12], wave: 'sawtooth', bpm: 70, drone: 55 },
  space: { root: 98, scale: [0, 2, 7, 9, 12, 14], wave: 'sine', bpm: 76, drone: 49 },
  lab: { root: 123.47, scale: [0, 1, 5, 7, 8, 12], wave: 'triangle', bpm: 84, drone: 61.7 },
  cyber: { root: 110, scale: [0, 3, 5, 7, 10, 12], wave: 'square', bpm: 104, drone: 55 },
  bunker: { root: 82.41, scale: [0, 3, 5, 6, 7, 10], wave: 'sawtooth', bpm: 64, drone: 41.2 },
};

const KEY = 'impostor.audio';
interface Prefs { master: number; music: number; sfx: number; muted: boolean }
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { master: 0.8, music: 0.5, sfx: 0.8, muted: false, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { master: 0.8, music: 0.5, sfx: 0.8, muted: false };
}
const savePrefs = (p: Prefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } };

class AudioEngine {
  prefs = loadPrefs();
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private ambient: { stop: () => void } | null = null;
  private scene: Scene = 'menu';
  private seqTimer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { this.listeners.forEach((l) => l()); }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.musicBus.connect(this.master); this.sfxBus.connect(this.master); this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.applyVolumes();
      this.startScene();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.prefs.muted ? 0 : this.prefs.master;
    this.musicBus.gain.value = this.prefs.music * 0.5;
    this.sfxBus.gain.value = this.prefs.sfx;
  }
  setVolume(k: 'master' | 'music' | 'sfx', v: number) { this.prefs[k] = v; savePrefs(this.prefs); this.applyVolumes(); this.changed(); }
  toggleMute() { this.prefs.muted = !this.prefs.muted; savePrefs(this.prefs); this.applyVolumes(); this.changed(); }

  setScene(s: Scene) {
    if (s === this.scene && this.seqTimer) return;
    this.scene = s;
    if (this.ctx) this.startScene();
  }

  private startScene() {
    const ctx = this.ctx; if (!ctx) return;
    if (this.seqTimer) clearInterval(this.seqTimer);
    this.ambient?.stop();
    const v = SCENES[this.scene];
    // ambient: slow detuned drone + filtered noise bed
    const drone = ctx.createOscillator(); const drone2 = ctx.createOscillator();
    const dg = ctx.createGain(); dg.gain.value = 0.05;
    const lfo = ctx.createOscillator(); const lg = ctx.createGain(); lfo.frequency.value = 0.15; lg.gain.value = 0.03;
    lfo.connect(lg); lg.connect(dg.gain);
    drone.frequency.value = v.drone; drone2.frequency.value = v.drone * 1.005; drone.type = 'sine'; drone2.type = 'triangle';
    drone.connect(dg); drone2.connect(dg); dg.connect(this.musicBus);
    const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuf; noise.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = this.scene === 'cyber' ? 1400 : 420;
    const ng = ctx.createGain(); ng.gain.value = 0.035;
    noise.connect(nf); nf.connect(ng); ng.connect(this.musicBus);
    [drone, drone2, lfo, noise].forEach((n) => n.start());
    this.ambient = { stop: () => { [drone, drone2, lfo, noise].forEach((n) => { try { n.stop(); } catch { /* ended */ } }); } };

    this.step = 0;
    const stepMs = 60000 / v.bpm / 2;
    this.seqTimer = setInterval(() => this.musicStep(v), stepMs);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, bus: GainNode, when = 0, slideTo?: number) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.05);
  }
  private noiseHit(dur: number, gain: number, freq: number, when = 0, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx; if (!ctx || !this.noiseBuf) return;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfxBus); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  private musicStep(v: Voicing) {
    const n = this.step++;
    const semi = (i: number) => v.root * Math.pow(2, v.scale[i % v.scale.length]! / 12);
    if (n % 16 === 0) { // pad chord
      [0, 2, 4].forEach((d, i) => this.tone(semi((n / 16 + d) | 0) * 2, 3.6, 'sine', 0.05 - i * 0.008, this.musicBus));
    }
    if (n % 4 === 0) this.tone(v.root / 2, 0.5, v.wave === 'square' ? 'square' : 'triangle', 0.08, this.musicBus);
    if (n % 2 === 1 || this.scene === 'cyber') {
      const idx = (n * 7 + (n >> 3)) % v.scale.length;
      if (Math.sin(n * 1.7) > -0.2) this.tone(semi(idx) * 4, 0.25, v.wave, 0.03, this.musicBus);
    }
  }

  sfx(name: Sfx) {
    if (!this.ctx || this.prefs.muted) return;
    const b = this.sfxBus;
    switch (name) {
      case 'click': this.tone(880, 0.06, 'square', 0.12, b); break;
      case 'vote': this.tone(520, 0.1, 'triangle', 0.25, b); this.tone(780, 0.14, 'triangle', 0.25, b, 0.08); break;
      case 'tick': this.tone(1200, 0.05, 'square', 0.15, b); break;
      case 'mission': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.25, b, i * 0.08)); break;
      case 'fail': this.tone(220, 0.3, 'sawtooth', 0.22, b, 0, 110); break;
      case 'sabotage': this.tone(440, 0.5, 'sawtooth', 0.28, b, 0, 880); this.tone(880, 0.5, 'sawtooth', 0.28, b, 0.5, 440); break;
      case 'eliminate': this.noiseHit(0.5, 0.5, 600); this.tone(180, 0.6, 'sawtooth', 0.3, b, 0, 40); break;
      case 'scream': this.tone(1400, 0.4, 'sawtooth', 0.18, b, 0, 500); break;
      case 'meeting': [330, 440, 330, 440, 660].forEach((f, i) => this.tone(f, 0.22, 'square', 0.22, b, i * 0.16)); break;
      case 'reveal': this.tone(110, 1.2, 'sawtooth', 0.3, b, 0, 220); this.noiseHit(1, 0.25, 2000, 0, 'highpass'); this.tone(660, 0.8, 'sine', 0.2, b, 0.8); break;
      case 'victory': [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.3, b, i * 0.15)); break;
      case 'defeat': [392, 349, 311, 262].forEach((f, i) => this.tone(f, 0.5, 'sawtooth', 0.22, b, i * 0.3)); break;
    }
  }

  /** Looping klaxon while a sabotage is active; faster when critical. */
  setAlarm(on: boolean, critical = false) {
    if (this.alarmTimer) { clearInterval(this.alarmTimer); this.alarmTimer = null; }
    if (!on) return;
    const hit = () => { if (this.ctx && !this.prefs.muted) { this.tone(critical ? 880 : 620, 0.25, 'square', 0.14, this.sfxBus, 0, critical ? 660 : 480); } };
    hit();
    this.alarmTimer = setInterval(hit, critical ? 500 : 1100);
  }
}

export const audio = new AudioEngine();
