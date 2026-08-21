# notifications

**Status: first real capability landed; still far from the full design.**

## What exists

- `MemberCreatedListener` subscribes to the domain event bus's `member.created`
  event (`src/events/domain-events.ts`) -- the first thing to ever consume it;
  the event has fired since the deep-foundation phase with no listener.
  Enqueues a `send-welcome-email` job onto the `notifications` BullMQ queue
  (`src/queue/`) when the created member has an email on file. Enqueue
  failures (e.g. Redis unreachable) are caught and logged, never thrown --
  this must never turn into a 500 on `POST /members`.
- `WelcomeEmailProcessor` consumes that job and calls
  `CommunicationsService.sendWelcomeEmail()` (`src/communications/`) --
  real SMTP delivery via `SmtpEmailProvider` when `SMTP_HOST`/
  `SMTP_FROM_ADDRESS` are configured, template-driven and logged to
  `MessageLog`. See `src/communications/README.md` for what's real there.
- Runs in-process (no separate worker deployment) -- see `src/queue/
  queue.module.ts`'s class comment for why that's fine at current scale.

## What's still a stub

- **No in-app/WhatsApp/SMS/push channels.** Email only (via
  `CommunicationsService`), and only the one message type routed through
  this queue -- WhatsApp/SMS/push have typed provider interfaces
  (`src/communications/interfaces/`) but no implementation wired in yet.
- **No delivery tracking, retry-visibility, or unsubscribe handling.**
  BullMQ retries a failed job 3x with backoff (queue-level default,
  `src/queue/queue.module.ts`), but nothing surfaces "this welcome email
  permanently failed" anywhere a human would see it.
- **Only one domain event is consumed.** `membership.started`,
  `payment.recorded`, `workout.assigned`, etc. all fire (see
  `src/events/domain-events.ts`) with no notification wired to any of them
  yet -- this was built as the first vertical slice through the new queue
  infrastructure, not a notifications rewrite.
- **No user-facing preferences/opt-out.** A real notification engine needs
  per-org/per-user channel preferences before it fans out beyond one email.

See `docs/ARCHITECTURE.md#notification-architecture` for the target design
this is measured against, and `docs/architecture/discovery-report.md` for
where this sits in the overall roadmap.
