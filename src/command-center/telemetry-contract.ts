/**
 * The telemetry contract: card name -> the keys the console renders.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * A card payload whose type is `unknown` on the wire gets read with a
 * runtime path walk:
 *
 *     pick(d, 'queues.totals.waiting')
 *
 * which returns `undefined` for a path that no longer exists, renders as an
 * em-dash, and looks exactly like a metric that is legitimately absent. So a
 * renamed field during a refactor would not break a build or fail a test — it
 * would quietly blank a number on an operations console, which is the one
 * place where a blank must mean "we could not measure this" and nothing else.
 *
 * ── Why a key list and not a schema library ─────────────────────────────────
 *
 * The useful property is narrow: does the payload a collector emits still
 * carry the fields the console renders? A validator would also police types
 * and nesting, which sounds better and costs more than it returns here — the
 * collectors are the only writers, they all live in this module, and each
 * grades its own values (see CollectorResult) before anyone reads them.
 *
 * What actually goes wrong is a RENAME during a refactor, and a key list
 * catches that at the cheapest possible price. `required` is a floor, not a
 * whitelist: a collector may add fields freely, which is what keeps this from
 * becoming a second place to edit on every change.
 *
 * Borrowed in shape from MY PT STUDIO's
 * `src/modules/command-center/telemetry-contract.js`, which was written
 * against the same failure mode. Ported, not copied — that one is CommonJS
 * against an untyped Express app; this one is a TS const the compiler reads.
 */

/** A card the console can render. */
export interface CardDefinition {
  /**
   * `platform` — describes the whole deployment, so only platform staff may
   * read it. `tenant` — scoped to one organization and readable by that
   * organization's own staff through the normal RBAC path.
   *
   * The Command Center itself is a `platform` surface, but a tenant-scoped
   * card is not automatically safe: a tenant card still must not leak another
   * tenant's numbers, so it keeps the ordinary organizationId-from-JWT
   * scoping rather than riding on PlatformRoleGuard.
   */
  scope: 'platform' | 'tenant';
  /** Keys that must be present on the value for the card to be usable. */
  required: readonly string[];
  /** Nested objects whose own keys are also part of the contract. */
  nested?: Readonly<Record<string, readonly string[]>>;
}

export const TELEMETRY_CONTRACT = {
  /** Reuses the existing readiness probe's dependencies. */
  readiness: {
    scope: 'platform',
    required: ['database', 'queue'],
  },

  /** BullMQ depth per queue, via the single shared QueueConnection. */
  queues: {
    scope: 'platform',
    required: ['queues', 'totals'],
    nested: {
      totals: ['waiting', 'active', 'failed', 'delayed', 'completed'],
    },
  },

  /** Connection round-trip latency and pool occupancy. */
  database: {
    scope: 'platform',
    required: ['latencyMs', 'reachable'],
  },

  /** In-process HTTP request timings from LoggingInterceptor's ring. */
  http: {
    scope: 'platform',
    required: ['samples', 'latencyMs', 'status'],
    nested: {
      latencyMs: ['p50', 'p95', 'p99'],
      status: ['2xx', '4xx', '5xx'],
    },
  },

  /**
   * AI spend and reliability, from AiUsageLog. `costUsd` is the provider's
   * own reported figure, never an estimate from a rate card (see the model
   * comment in schema.prisma).
   */
  ai: {
    scope: 'platform',
    required: ['requests', 'success', 'errors', 'costUsd', 'tokens'],
    nested: {
      tokens: ['prompt', 'completion', 'total'],
      latencyMs: ['p50', 'p95'],
    },
  },

  /** Counts of pending approvals and execution outcomes. */
  aiActions: {
    scope: 'platform',
    required: ['pendingApproval', 'approved', 'rejected', 'executed', 'failed'],
  },

  /** Background scanner outcomes, from AutomationRun. */
  automation: {
    scope: 'platform',
    required: ['sent', 'skipped', 'failed', 'windowMs'],
  },
} as const satisfies Record<string, CardDefinition>;

export type CardName = keyof typeof TELEMETRY_CONTRACT;
