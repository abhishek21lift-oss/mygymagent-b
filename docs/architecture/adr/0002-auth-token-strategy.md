# ADR 0002: JWT access tokens + opaque, hashed, rotating refresh tokens

## Status
Accepted, implemented.

## Context
Need a session model that's stateless enough to scale (no session lookup on every request) but
still allows revoking a single compromised session without invalidating every device a user is
logged in on.

## Options considered
1. **JWT for everything (access + refresh)** — fully stateless, but a leaked refresh JWT is valid
   until expiry with no way to revoke it short of rotating the signing secret (which invalidates
   *every* user's session, not just the compromised one).
2. **Server-side session store for everything** — fully revocable, but a DB round-trip on every
   authenticated request.
3. **Short-lived JWT access token + opaque, DB-backed refresh token.**

## Decision
Option 3. The access token is a signed JWT (15 min default), verified against the DB on every
request via `JwtStrategy` (`src/auth/strategies/jwt.strategy.ts`) — not purely stateless, but cheap
(single indexed lookup) and lets us reject a token immediately if the user is deactivated mid-session.
The refresh token is an opaque random value, stored **sha256-hashed** (never plaintext) in
`RefreshToken`, delivered as an `httpOnly`, `path: '/auth'` cookie, and **rotated** on every use — a
reused old refresh token is treated as a compromise signal (see `AuthService`/`TokensService`).

## Trade-offs
- Two token types instead of one — more moving parts than "just use JWTs everywhere," but the
  refresh token being individually revocable (log out one device without logging out all of them)
  was worth it for a product where a member might be logged in on a kiosk, a phone, and a staff
  workstation simultaneously.
- The access-token DB check means it isn't purely stateless — accepted, since it's a single indexed
  lookup, not a session-store round trip, and it buys immediate deactivation.

## Consequences
Refresh-token rotation, revocation-on-reuse, and expiry are covered by
`test/auth.e2e-spec.ts`. The cookie is scoped to the backend's own origin, which is why the
frontend does client-side auth gating rather than an edge-level cookie check across origins — see
`mygymagent-f/README.md`'s "Auth architecture" section.
