/**
 * Per-carrier daily call budget.
 *
 * Purpose: guarantee the system never leaves the free tier. DHL's free grant
 * is 250 calls/day, which is the binding constraint; the default cap is 200 to
 * leave headroom for retries. When a budget is exhausted the affected packages
 * are reported as UNCONFIRMED with reason BUDGET_EXHAUSTED rather than being
 * shown with stale data presented as current.
 *
 * The window is a UTC calendar day, persisted in state so it survives between
 * the ~96 runs per day.
 */

const today = () => new Date().toISOString().slice(0, 10);

export class Budget {
  constructor(persisted = {}, limits = {}) {
    this.day = persisted.day === today() ? persisted.day : today();
    this.used = persisted.day === today() ? { ...(persisted.used || {}) } : {};
    this.limits = limits;
    this.denied = {};
  }

  remaining(carrier) {
    const limit = this.limits[carrier];
    if (!Number.isFinite(limit)) return Infinity;
    return Math.max(0, limit - (this.used[carrier] || 0));
  }

  /** Reserve one call. Returns false when the cap would be exceeded. */
  take(carrier, n = 1) {
    if (this.remaining(carrier) < n) {
      this.denied[carrier] = (this.denied[carrier] || 0) + n;
      return false;
    }
    this.used[carrier] = (this.used[carrier] || 0) + n;
    return true;
  }

  /** Give back calls that were reserved but provably never made. */
  refund(carrier, n = 1) {
    this.used[carrier] = Math.max(0, (this.used[carrier] || 0) - n);
  }

  snapshot() {
    return { day: this.day, used: { ...this.used } };
  }

  report() {
    const out = {};
    for (const carrier of Object.keys(this.limits)) {
      out[carrier] = {
        used: this.used[carrier] || 0,
        limit: this.limits[carrier],
        denied: this.denied[carrier] || 0,
      };
    }
    return out;
  }
}
