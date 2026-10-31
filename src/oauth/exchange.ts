// RFC 8693 token exchange at the authorization server's token endpoint: the
// inbound MCP-audience token is traded for a short-lived API-audience token.
// The inbound token itself is never sent to the REST API (no passthrough).
//
// The exchange budget is shared by every user of this server, so nothing a
// single caller does may spend it freely:
//  - a subject token LexAPI refused is remembered until it expires (negative
//    cache): replaying it costs nothing upstream;
//  - per subject token, per user (`sub`) and per client IP, the number of
//    exchanges / refusals is bounded locally; every NEW exchange of a user,
//    successful or refused, counts against a per-user cap, so minting
//    fresh tokens cannot spend the budget faster than that;
//  - when the server answers 429 / 503 temporarily_unavailable, the user's new
//    exchanges wait out its Retry-After (with backoff); when the slow-down is
//    global (see slowDown()) every new exchange waits and then ONE probe goes
//    first, so recovery does not stampede.

import { createHash } from 'node:crypto';

import { readCappedText } from './body.js';
import { DEFAULT_EXCHANGES_PER_USER_PER_MIN } from './config.js';
import { CLOCK_SKEW_S } from './jwt.js';
import { redact } from './redact.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
/** A cached API token is dropped this long before its `exp`. */
export const EXPIRY_MARGIN_MS = 30_000;
export const DEFAULT_MAX_ENTRIES = 10_000;
/**
 * One exchange (both attempts, the backoff between them included) never
 * takes longer than this: under the first progress frame (10 s) and the SSE
 * keep-alive (15 s), so a refusal found by the exchange is still answered
 * with its HTTP status rather than as a tool error after the 200.
 */
export const EXCHANGE_DEADLINE_MS = 9_000;
const ATTEMPT_TIMEOUT_MS = 6_000;
const MIN_RETRY_WINDOW_MS = 1_500;
const RETRY_BACKOFF_MS = 300;
const MAX_RESPONSE_BYTES = 16 * 1024;

/** Local limits. Windows are fixed, one minute unless stated. */
export const LIMITS = {
  /** Exchanges started for one subject token per minute (normal use: one per ~4.5 min, two after an API 401). */
  perTokenPerMin: 6,
  /**
   * Exchanges LexAPI refused (user-token rejections) per client IP per minute;
   * past it, accounts with a recent refusal of their own are cut off from that
   * address (never an account with a clean record).
   */
  refusedPerIpPerMin: 30,
  /** …and per user (`sub`) per 10 minutes. */
  refusedPerSubPer10Min: 10,
  /**
   * NEW exchanges started for one user (`sub`) per minute, successful or
   * refused (LEXAPI_MCP_EXCHANGES_PER_USER_PER_MIN). Normal use is one
   * per connection every ~4.5 min; cached tokens never count.
   */
  exchangesPerSubPerMin: DEFAULT_EXCHANGES_PER_USER_PER_MIN,
  /**
   * A slow-down (429 / 503 temporarily_unavailable) is treated as about one
   * user until this many distinct users got one within a minute: then it is
   * global, and every new exchange waits.
   */
  slowDownGlobalAfterUsers: 3,
  /** Backoff after a 429 / 503 temporarily_unavailable: doubles per consecutive one; Retry-After is a floor. */
  throttleMinMs: 1_000,
  throttleMaxMs: 5 * 60_000,
  /** A refusal is remembered no longer than this (the subject's `exp` normally ends it sooner). */
  negativeMaxMs: 60 * 60_000,
};

/**
 * How the token endpoint says "the subject token is not usable" (revoked,
 * expired …): `400 invalid_request` whose description begins with exactly
 * this prefix (RFC 8693 §2.2.2 leaves no distinct error code). Only this is
 * the USER's problem (→ 401 invalid_token, refresh / re-authorize); every
 * other 400 means our
 * exchange request is wrong (→ 500, logged, counted) — mapping those to 401
 * would push every user into a re-auth loop while hiding the bug.
 */
export const SUBJECT_REJECTED_PREFIX = 'subject_token rejected: ';
/** After refused client authentication, slow-downs are treated as global for this long. */
const CLIENT_AUTH_GLOBAL_MS = 15 * 60_000;

/**
 * Why an exchange failed, and what the MCP client is told:
 *  invalid_token → 401 invalid_token (the user's token is no longer usable: refresh / re-authorize)
 *  config        → 500 (any 400 without the subject_token-rejected prefix: our exchange request is wrong)
 *  client_auth   → 503 (our client credentials were refused — never make users re-authorize for it)
 *  unavailable   → 503 (the AS is not configured / temporarily_unavailable)
 *  rate_limited  → 429 (the token endpoint's 429, or a local limit; Retry-After honoured)
 *  upstream      → 502 (5xx or network error after one retry, or a malformed success)
 */
type SlowDownKind = 'rate_limited' | 'unavailable';

export type ExchangeFailure = 'invalid_token' | 'config' | 'client_auth' | 'unavailable' | 'rate_limited' | 'upstream';

export class ExchangeError extends Error {
  constructor(
    public readonly kind: ExchangeFailure,
    /** Token-free description (the AS's error_description, or ours). */
    public readonly description: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`token exchange failed: ${kind}`);
    this.name = 'ExchangeError';
  }
}

export interface TokenExchangerOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** `resource` of the requested token — the LexAPI API audience. */
  apiAudience: string;
  maxEntries?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<typeof LIMITS>;
  /** Overall bound of one exchange (default EXCHANGE_DEADLINE_MS; tests shorten it). */
  deadlineMs?: number;
}

/** Who is asking — for the per-IP / per-user limits. */
export interface ExchangeCaller {
  ip?: string;
  sub?: string;
}

interface Entry {
  token: string;
  /** ms epoch after which the entry is not used. */
  useUntil: number;
}

interface Refusal {
  description: string;
  until: number;
}

/** Counters exposed on /health (no identifiers, no tokens). */
export interface ExchangeStats {
  /** Requests sent to the token endpoint, retries included. */
  requests: number;
  succeeded: number;
  /** LexAPI refused the subject token (user-side: revoked / expired …). */
  userTokenRejected: number;
  /** Refusals answered from the negative cache (no request sent). */
  negativeCacheHits: number;
  /** 400s that are NOT a subject_token rejection: our request is wrong. */
  configErrors: number;
  /** 401/403 from the token endpoint: our client credentials. */
  clientAuthErrors: number;
  /** The token endpoint's 429. */
  rateLimited: number;
  /** The token endpoint's 503 temporarily_unavailable. */
  unavailable: number;
  /** 5xx / network / malformed answers, after the retry. */
  upstreamErrors: number;
  /** Exchanges refused locally (per-token / per-IP / per-user limit, or backoff). */
  locallyLimited: number;
  cacheSize: number;
  negativeCacheSize: number;
  /** Seconds left of a requested backoff that holds back EVERY user (0: none). */
  backoffSeconds: number;
  /** Users whose own new exchanges are held back right now (per-user slow-down). */
  usersBackingOff: number;
}

/** application/x-www-form-urlencoded encoding of a Basic credential part (RFC 6749 §2.3.1). */
function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

/**
 * Cache key of a subject token: sha256 of its signed part (`header.payload`),
 * never the token itself. The signature segment is left out on purpose: an
 * ECDSA signature has a second valid form (s → n − s) for the same signed
 * bytes, so keying on the whole
 * string would let one token occupy two entries. Two tokens with the same
 * signed part ARE the same token. Only used on tokens that passed local
 * signature verification.
 */
export function subjectKey(subjectToken: string): string {
  const parts = subjectToken.split('.');
  const signed = parts.length === 3 ? `${parts[0]}.${parts[1]}` : subjectToken;
  return createHash('sha256').update(signed).digest('base64url');
}

/** A fixed-window counter per key, bounded in size (oldest windows dropped first). */
class WindowCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly windowMs: number, private readonly maxKeys: number) {}

  count(key: string, now: number): number {
    const w = this.windows.get(key);
    return w && now < w.resetAt ? w.count : 0;
  }

  retryAfterS(key: string, now: number): number {
    const w = this.windows.get(key);
    return w && now < w.resetAt ? Math.max(1, Math.ceil((w.resetAt - now) / 1000)) : 1;
  }

  hit(key: string, now: number): void {
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.windows.delete(key);
      w = { count: 0, resetAt: now + this.windowMs };
    }
    w.count += 1;
    this.windows.set(key, w);
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

/**
 * Exchanges subject tokens and caches the resulting API tokens per subject
 * token until 30 s before they expire, in a bounded in-memory LRU; refused
 * subject tokens are remembered until they expire. Concurrent requests
 * carrying the same subject token share one exchange. Nothing is persisted
 * or logged.
 */
export class TokenExchanger {
  private readonly cache = new Map<string, Entry>();
  private readonly refused = new Map<string, Refusal>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxEntries: number;
  private readonly basic: string;
  private readonly limits: typeof LIMITS;
  private readonly perToken: WindowCounter;
  private readonly refusedPerIp: WindowCounter;
  private readonly refusedPerSub: WindowCounter;
  private readonly exchangesPerSub: WindowCounter;
  /** Backoff after a 429 / 503 temporarily_unavailable, for everyone. */
  private throttle = { until: 0, kind: 'rate_limited' as SlowDownKind, consecutive: 0, probing: false };
  /** …or for one user (`sub`): only that user's new exchanges wait. Bounded, oldest first. */
  private readonly subThrottle = new Map<string, { until: number; kind: SlowDownKind; consecutive: number }>();
  /** Users slowed down in the last minute (sub → expiry), to tell a per-user slow-down from a global one. */
  private readonly slowedSubs = new Map<string, number>();
  private readonly counters = {
    requests: 0, succeeded: 0, userTokenRejected: 0, negativeCacheHits: 0, configErrors: 0,
    clientAuthErrors: 0, rateLimited: 0, unavailable: 0, upstreamErrors: 0, locallyLimited: 0,
  };
  private readonly loud = new LoudLog();
  private lastClientAuthFailureAt = -Infinity;

  constructor(private readonly opts: TokenExchangerOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.limits = { ...LIMITS, ...(opts.limits ?? {}) };
    this.basic = `Basic ${Buffer.from(`${formEncode(opts.clientId)}:${formEncode(opts.clientSecret)}`).toString('base64')}`;
    this.perToken = new WindowCounter(60_000, this.maxEntries);
    this.refusedPerIp = new WindowCounter(60_000, this.maxEntries);
    this.refusedPerSub = new WindowCounter(10 * 60_000, this.maxEntries);
    this.exchangesPerSub = new WindowCounter(60_000, this.maxEntries);
  }

  get size(): number {
    return this.cache.size;
  }

  get negativeSize(): number {
    return this.refused.size;
  }

  /** Requests sent to the token endpoint, retries included. */
  get exchanges(): number {
    return this.counters.requests;
  }

  stats(): ExchangeStats {
    const now = this.now();
    return {
      ...this.counters,
      cacheSize: this.cache.size,
      negativeCacheSize: this.refused.size,
      backoffSeconds: now < this.throttle.until ? Math.ceil((this.throttle.until - now) / 1000) : 0,
      usersBackingOff: [...this.subThrottle.values()].filter((st) => now < st.until).length,
    };
  }

  /**
   * An API token for this subject token: cached, or exchanged now.
   * `subjectExpS` (the subject's `exp`) caps both caches. Throws
   * ExchangeError; aborts with `signal` (the shared exchange keeps running
   * for other waiters).
   */
  async getApiToken(subjectToken: string, subjectExpS: number, signal?: AbortSignal, caller: ExchangeCaller = {}): Promise<string> {
    const key = subjectKey(subjectToken);
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit) {
      if (now < hit.useUntil) {
        // LRU touch.
        this.cache.delete(key);
        this.cache.set(key, hit);
        return hit.token;
      }
      this.cache.delete(key);
    }
    const no = this.refused.get(key);
    if (no) {
      if (now < no.until) {
        this.counters.negativeCacheHits += 1;
        throw new ExchangeError('invalid_token', no.description);
      }
      this.refused.delete(key);
    }
    let p = this.inflight.get(key);
    if (!p) {
      this.admit(key, now, caller);
      p = this.exchange(subjectToken, subjectExpS, key, caller).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const entry = await raceAbort(p, signal);
    return entry.token;
  }

  /**
   * Forget the cached API token of this subject after the API refused it
   * (401 invalid_token) — only if it is still the one that was refused, so
   * a fresher token another request just obtained survives.
   */
  invalidate(subjectToken: string, apiToken: string | undefined): void {
    const key = subjectKey(subjectToken);
    const hit = this.cache.get(key);
    if (hit && (apiToken === undefined || hit.token === apiToken)) this.cache.delete(key);
  }

  /** Local limits before a NEW exchange is started; throws a rate_limited ExchangeError. */
  private admit(key: string, now: number, caller: ExchangeCaller): void {
    const refuse = (description: string, retryAfterS: number) => {
      this.counters.locallyLimited += 1;
      throw new ExchangeError('rate_limited', description, retryAfterS);
    };
    const t = this.throttle;
    if (now < t.until) {
      this.counters.locallyLimited += 1;
      throw new ExchangeError(t.kind, 'LexAPI sign-in asked this server to slow down', Math.ceil((t.until - now) / 1000));
    }
    // Backoff over: one probe at a time until the server answers normally again.
    if (t.consecutive > 0 && t.probing) refuse('LexAPI sign-in is recovering from a rate limit', 1);
    // This user only was slowed down: their new exchanges wait, nobody else's.
    const st = caller.sub ? this.subThrottle.get(caller.sub) : undefined;
    if (st && now < st.until) {
      this.counters.locallyLimited += 1;
      throw new ExchangeError(st.kind, 'LexAPI sign-in asked this server to slow down for this account', Math.ceil((st.until - now) / 1000));
    }
    if (this.perToken.count(key, now) >= this.limits.perTokenPerMin) {
      refuse('too many sign-in checks for this connection', this.perToken.retryAfterS(key, now));
    }
    // The per-address limit only ever stops an account that has ALREADY been
    // refused recently: many users can share one address (a hosted
    // client's egress, a corporate NAT, or everyone when
    // LEXAPI_MCP_TRUST_PROXY_HOPS is wrong), so a flood of refusals from an
    // address must never block a user with a clean record there. A flood is
    // still throttled: once the address is over its limit, every account
    // that has been refused gets no further exchange until the window ends,
    // so each attacker account costs at most one exchange per window.
    const subRefused = caller.sub ? this.refusedPerSub.count(caller.sub, now) : 0;
    if (caller.ip && subRefused > 0 && this.refusedPerIp.count(caller.ip, now) >= this.limits.refusedPerIpPerMin) {
      refuse('too many refused sign-ins from this address', this.refusedPerIp.retryAfterS(caller.ip, now));
    }
    if (caller.sub && subRefused >= this.limits.refusedPerSubPer10Min) {
      refuse('too many refused sign-ins for this account', this.refusedPerSub.retryAfterS(caller.sub, now));
    }
    // Every new exchange of a user counts, successful or refused: a
    // clean account minting fresh tokens costs at most this many a minute.
    if (caller.sub && this.exchangesPerSub.count(caller.sub, now) >= this.limits.exchangesPerSubPerMin) {
      refuse(`too many new sign-ins for this account (at most ${this.limits.exchangesPerSubPerMin} a minute)`, this.exchangesPerSub.retryAfterS(caller.sub, now));
    }
    this.perToken.hit(key, now);
    if (caller.sub) this.exchangesPerSub.hit(caller.sub, now);
    if (t.consecutive > 0) t.probing = true;
  }

  private store(key: string, entry: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private remember(key: string, refusal: Refusal): void {
    this.refused.delete(key);
    this.refused.set(key, refusal);
    while (this.refused.size > this.maxEntries) {
      const oldest = this.refused.keys().next().value;
      if (oldest === undefined) break;
      this.refused.delete(oldest);
    }
  }

  private async exchange(subjectToken: string, subjectExpS: number, key: string, caller: ExchangeCaller): Promise<Entry> {
    let settledNormally = false;
    try {
      const entry = await this.attempts(subjectToken, subjectExpS, key, caller);
      settledNormally = true;
      return entry;
    } catch (err) {
      settledNormally = !(err instanceof ExchangeError && (err.kind === 'rate_limited' || err.kind === 'unavailable'));
      throw err;
    } finally {
      if (this.throttle.probing) {
        this.throttle.probing = false;
        // The server answered something other than "slow down": the backoff is over.
        if (settledNormally) this.throttle.consecutive = 0;
      }
      if (settledNormally && caller.sub) this.subThrottle.delete(caller.sub);
    }
  }

  /** How long to hold back after the `consecutive`-th slow-down in a row: doubling, Retry-After as a floor. */
  private holdMs(consecutive: number, retryAfterS: number | undefined): number {
    const backoff = Math.min(this.limits.throttleMaxMs, this.limits.throttleMinMs * 2 ** Math.min(consecutive - 1, 16));
    const floor = retryAfterS !== undefined ? Math.min(this.limits.throttleMaxMs, retryAfterS * 1000) : 0;
    return Math.max(backoff, floor);
  }

  /** Hold every new exchange back (a global slow-down). */
  private backOff(kind: SlowDownKind, retryAfterS: number | undefined): void {
    const t = this.throttle;
    t.consecutive += 1;
    t.until = this.now() + this.holdMs(t.consecutive, retryAfterS);
    t.kind = kind;
  }

  /**
   * The token endpoint answered 429 / 503 `temporarily_unavailable`
   * (+ Retry-After). Returns the seconds the caller must wait and whether it
   * was global.
   *
   * The answer alone does not say whether it concerns one user or everyone.
   * The rule: a slow-down is about THIS user — only their new
   * exchanges wait, other users carry on — unless it is clearly global:
   *  - no user is known for the exchange;
   *  - it follows refused client authentication (that affects every user);
   *  - `slowDownGlobalAfterUsers` distinct users were slowed down within a
   *    minute.
   * A global slow-down holds every new exchange back, then lets one probe go
   * first (as before). Either way the answer is a 429 / 503, never a re-auth.
   */
  private slowDown(kind: SlowDownKind, retryAfterS: number | undefined, caller: ExchangeCaller): { waitS: number; global: boolean } {
    const now = this.now();
    let global = !caller.sub || Date.now() - this.lastClientAuthFailureAt < CLIENT_AUTH_GLOBAL_MS;
    if (caller.sub && !global) {
      this.slowedSubs.delete(caller.sub);
      this.slowedSubs.set(caller.sub, now + 60_000);
      for (const [s, until] of this.slowedSubs) {
        if (until > now && this.slowedSubs.size <= this.maxEntries) break;
        this.slowedSubs.delete(s);
      }
      global = this.slowedSubs.size >= this.limits.slowDownGlobalAfterUsers;
    }
    if (global) {
      this.backOff(kind, retryAfterS);
      return { waitS: Math.ceil((this.throttle.until - now) / 1000), global };
    }
    const sub = caller.sub!;
    const consecutive = (this.subThrottle.get(sub)?.consecutive ?? 0) + 1;
    const until = now + this.holdMs(consecutive, retryAfterS);
    this.subThrottle.delete(sub);
    this.subThrottle.set(sub, { until, kind, consecutive });
    while (this.subThrottle.size > this.maxEntries) {
      const oldest = this.subThrottle.keys().next().value;
      if (oldest === undefined) break;
      this.subThrottle.delete(oldest);
    }
    return { waitS: Math.ceil((until - now) / 1000), global };
  }

  private async attempts(subjectToken: string, subjectExpS: number, key: string, caller: ExchangeCaller): Promise<Entry> {
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      resource: this.opts.apiAudience,
    }).toString();
    const deadline = Date.now() + (this.opts.deadlineMs ?? EXCHANGE_DEADLINE_MS);

    for (let attempt = 0; ; attempt++) {
      const remaining = () => deadline - Date.now();
      const canRetry = () => attempt === 0 && remaining() - RETRY_BACKOFF_MS >= MIN_RETRY_WINDOW_MS;
      let res: Response;
      this.counters.requests += 1;
      try {
        res = await this.fetchImpl(this.opts.tokenEndpoint, {
          method: 'POST',
          headers: {
            authorization: this.basic,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, remaining()))),
        });
      } catch (err) {
        if (canRetry()) {
          await this.sleep(RETRY_BACKOFF_MS);
          continue;
        }
        this.counters.upstreamErrors += 1;
        // Runtime messages can quote request data: report the class only.
        throw new ExchangeError('upstream', `the authorization server could not be reached (${err instanceof Error ? err.name : 'error'})`);
      }

      const text = await readCappedText(res, MAX_RESPONSE_BYTES).catch(() => '');
      const json = safeJson(text);
      const err = typeof json?.error === 'string' ? json.error : undefined;
      const rawDesc = typeof json?.error_description === 'string' ? json.error_description : '';
      const desc = redact(rawDesc || err || `HTTP ${res.status}`, [subjectToken, this.opts.clientSecret]);

      if (res.status === 200) {
        const token = json?.access_token;
        const type = json?.token_type;
        const expiresIn = json?.expires_in;
        if (typeof token !== 'string' || !token || typeof type !== 'string' || type.toLowerCase() !== 'bearer') {
          this.counters.upstreamErrors += 1;
          throw new ExchangeError('upstream', 'the authorization server returned a malformed token response');
        }
        this.counters.succeeded += 1;
        const now = this.now();
        // Honour expires_in (may be well under 300 s) and never outlive the subject token.
        const expMs = Math.min(
          typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now,
          subjectExpS * 1000,
        );
        const entry = { token, useUntil: expMs - EXPIRY_MARGIN_MS };
        // Too close to expiry to cache: this call uses it, the next one exchanges again.
        if (entry.useUntil > now) this.store(key, entry);
        return entry;
      }

      if (res.status === 400) {
        if (err === 'invalid_request' && rawDesc.startsWith(SUBJECT_REJECTED_PREFIX)) {
          // The user's token is no longer usable — and never will be again:
          // remember it until it expires, so replaying it costs nothing upstream.
          this.counters.userTokenRejected += 1;
          const now = this.now();
          const until = Math.min(now + this.limits.negativeMaxMs, Math.max(now + 1_000, (subjectExpS + CLOCK_SKEW_S) * 1000));
          this.remember(key, { description: desc, until });
          if (caller.ip) this.refusedPerIp.hit(caller.ip, now);
          if (caller.sub) this.refusedPerSub.hit(caller.sub, now);
          throw new ExchangeError('invalid_token', desc);
        }
        this.counters.configErrors += 1;
        this.loud.log('config', `token exchange refused our request (${err ?? 'HTTP 400'}): ${desc} — this is a bug or misconfiguration on this server, not the user's token`);
        throw new ExchangeError('config', desc);
      }
      if (res.status === 401 || res.status === 403) {
        this.counters.clientAuthErrors += 1;
        this.lastClientAuthFailureAt = Date.now();
        this.loud.log('client_auth', `token exchange: client authentication refused (${err ?? `HTTP ${res.status}`}): ${desc} — check LEXAPI_OAUTH_CLIENT_ID / LEXAPI_OAUTH_CLIENT_SECRET `);
        throw new ExchangeError('client_auth', desc);
      }
      if (res.status === 429) {
        // `temporarily_unavailable` (RFC 6749) or `rate_limited`, with Retry-After.
        this.counters.rateLimited += 1;
        const ra = retryAfterSeconds(res.headers.get('retry-after'));
        const { waitS, global } = this.slowDown('rate_limited', ra, caller);
        // Right after refused client authentication a 429 most likely has the
        // same cause: say so, or a wrong secret looks like load.
        const authHint = Date.now() - this.lastClientAuthFailureAt < CLIENT_AUTH_GLOBAL_MS
          ? ' — this follows refused client authentication: check LEXAPI_OAUTH_CLIENT_SECRET'
          : '';
        // A per-user slow-down is not an operator problem; a global one is.
        if (global) this.loud.log('rate_limited', `token exchange rate limited (${err ?? 'HTTP 429'}); holding new exchanges back for ${waitS} s${authHint}`);
        throw new ExchangeError('rate_limited', desc, waitS);
      }
      if (res.status === 503 && err === 'temporarily_unavailable') {
        this.counters.unavailable += 1;
        const { waitS, global } = this.slowDown('unavailable', retryAfterSeconds(res.headers.get('retry-after')), caller);
        if (global) this.loud.log('unavailable', `token exchange: sign-in temporarily unavailable: ${desc}`);
        throw new ExchangeError('unavailable', desc, waitS);
      }
      if (res.status >= 500 && canRetry()) {
        await this.sleep(RETRY_BACKOFF_MS);
        continue;
      }
      this.counters.upstreamErrors += 1;
      throw new ExchangeError('upstream', `the authorization server answered ${res.status}`);
    }
  }
}

/** Loud, scrubbed operator log lines — at most one per kind per 10 s, with a count of the ones held back. */
class LoudLog {
  private readonly last = new Map<string, { at: number; suppressed: number }>();

  log(kind: string, message: string): void {
    const now = Date.now();
    const l = this.last.get(kind);
    if (l && now - l.at < 10_000) {
      l.suppressed += 1;
      return;
    }
    const extra = l?.suppressed ? ` (+${l.suppressed} more since the last report)` : '';
    this.last.set(kind, { at: now, suppressed: 0 });
    console.error(`[lexapi-mcp] OAUTH CONFIGURATION PROBLEM: ${message}${extra}`);
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Waits for `p`, or rejects as soon as `signal` aborts (without cancelling `p`). */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
