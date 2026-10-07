/**
 * Failed-login limits for POST /admin/api/login, kept in memory: this is a
 * single-process service, so no shared store is needed, but every restart
 * or redeploy clears all counters and lockouts.
 *
 * Per account: 5 failures within 15 minutes lock that email for 15 minutes
 * (counted for unknown emails too, so a lockout reveals nothing about which
 * emails are admins). Per IP: 100 failures within 15 minutes block that IP
 * until the oldest falls out of the window - best-effort, since the IP is
 * only as trustworthy as the proxy hop it is read from (see server.ts).
 *
 * The per-IP block is NOT enforced for now (enforceIpLimit: false): on
 * Railway, req.ip turned out to be a shared Railway proxy address, not the
 * client's, so enforcing it would let anyone block every admin's login.
 * IP failures are still counted, so enforcing it again is a one-flag change
 * once the real client IP source is confirmed.
 */
export const ACCOUNT_MAX_FAILURES = 5;
export const IP_MAX_FAILURES = 100;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const ACCOUNT_LOCK_MS = 15 * 60 * 1000;

// Above this many tracked keys, expired entries are swept on the next
// failure, so a flood of made-up emails can't grow memory without bound.
const SWEEP_THRESHOLD = 10_000;

interface AccountEntry {
  failures: number[];
  lockedUntil: number;
}

export interface LoginRateLimiter {
  /** Milliseconds until this email/IP may try again, or 0 if allowed now. */
  retryAfterMs(email: string, ip: string): number;
  recordFailure(email: string, ip: string): void;
  recordSuccess(email: string): void;
}

export function createLoginRateLimiter(options: { enforceIpLimit: boolean }): LoginRateLimiter {
  const accounts = new Map<string, AccountEntry>();
  const ips = new Map<string, number[]>();

  function recent(timestamps: number[], now: number): number[] {
    return timestamps.filter((t) => now - t < FAILURE_WINDOW_MS);
  }

  function sweep(now: number): void {
    for (const [email, entry] of accounts) {
      if (entry.lockedUntil <= now && recent(entry.failures, now).length === 0) accounts.delete(email);
    }
    for (const [ip, failures] of ips) {
      if (recent(failures, now).length === 0) ips.delete(ip);
    }
  }

  return {
    retryAfterMs(email, ip) {
      const now = Date.now();
      const accountWait = Math.max(0, (accounts.get(email)?.lockedUntil ?? 0) - now);
      const ipFailures = recent(ips.get(ip) ?? [], now);
      const ipWait =
        options.enforceIpLimit && ipFailures.length >= IP_MAX_FAILURES
          ? ipFailures[0] + FAILURE_WINDOW_MS - now
          : 0;
      return Math.max(accountWait, ipWait);
    },

    recordFailure(email, ip) {
      const now = Date.now();
      if (accounts.size + ips.size > SWEEP_THRESHOLD) sweep(now);

      const entry = accounts.get(email) ?? { failures: [], lockedUntil: 0 };
      entry.failures = [...recent(entry.failures, now), now];
      if (entry.failures.length >= ACCOUNT_MAX_FAILURES) {
        entry.lockedUntil = now + ACCOUNT_LOCK_MS;
        entry.failures = [];
      }
      accounts.set(email, entry);

      ips.set(ip, [...recent(ips.get(ip) ?? [], now), now].slice(-IP_MAX_FAILURES));
    },

    recordSuccess(email) {
      accounts.delete(email);
    },
  };
}
