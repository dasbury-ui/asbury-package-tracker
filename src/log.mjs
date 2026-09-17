/**
 * Structured logging with credential redaction.
 *
 * Run logs are public (GitHub Actions logs on a public repo), so anything that
 * could carry a secret or a vendor's business detail is redacted here rather
 * than relying on every call site to remember.
 */

const SECRET_PATTERNS = [];

/** Register a literal secret value so it can never appear in a log line. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) {
    SECRET_PATTERNS.push(value);
  }
}

export function redact(input) {
  let s = typeof input === 'string' ? input : JSON.stringify(input);
  if (s === undefined) return '';
  for (const secret of SECRET_PATTERNS) {
    s = s.split(secret).join('[REDACTED]');
  }
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{10,}/gi, '$1[REDACTED]')
    .replace(/("(?:access_token|refresh_token|client_secret|private_key|api_key|DHL-API-Key)"\s*:\s*")[^"]+/gi, '$1[REDACTED]')
    // Catch any email address that reached a log line by another route.
    .replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2');
}

/** Mask a tracking number in public logs: keep the shape, lose the identity. */
export function maskNumber(n) {
  const s = String(n || '');
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`;
}

/**
 * Mask an email address. Run logs and health.json are both public, so
 * employee mailbox names must not appear in either. "shop@asburycabinets.com"
 * becomes "s***@asburycabinets.com" - enough to tell mailboxes apart when
 * diagnosing, not enough to enumerate staff.
 */
export function maskEmail(address) {
  const s = String(address || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  return `${local[0]}${'*'.repeat(Math.max(2, local.length - 1))}${domain}`;
}

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.LOG_LEVEL || 'info'] ?? 20;

function emit(level, message, fields) {
  if (levels[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg: message,
    ...(fields || {}),
  };
  const out = redact(JSON.stringify(line));
  if (level === 'error' || level === 'warn') process.stderr.write(`${out}\n`);
  else process.stdout.write(`${out}\n`);
}

export const log = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};

/**
 * The parse decision log. Every candidate seen in every email produces one
 * entry, whether admitted or rejected, so a wrong result can be traced back to
 * the exact message and the exact rule that made the call.
 */
export class DecisionLog {
  constructor(previous = [], limit = 2000) {
    this.entries = Array.isArray(previous) ? previous.slice() : [];
    this.limit = limit;
  }

  add(entry) {
    this.entries.push({ at: new Date().toISOString(), ...entry });
  }

  /** Newest first, trimmed to the retention limit. */
  finalise() {
    this.entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return this.entries.slice(0, this.limit);
  }
}
