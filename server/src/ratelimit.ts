/** Fixed-window per-key limiter, small enough to live in process memory. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    if (now - this.lastSweep > 60_000) {
      for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
      this.lastSweep = now;
    }
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) { this.hits.set(key, { count: 1, resetAt: now + windowMs }); return true; }
    h.count++;
    return h.count <= max;
  }
}
