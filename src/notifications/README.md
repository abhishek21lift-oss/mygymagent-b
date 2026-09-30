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

## Push (B-P1-1)

- **Devices** -- `src/notifications/push/`. `POST /notifications/devices
  {token}` registers the caller's FCM token; `GET` lists their devices
  (never the token); `DELETE /notifications/devices/:id` and `POST
  /notifications/devices/unregister {token}` remove one; `GET .../status`
  says whether push is configured; `POST .../test` sends a test push to
  the caller's own devices. No permission: personal, keyed on the JWT
  user. Registering a token deletes any other row for it, in any org --
  a token is an app install, and a shared tablet must stop receiving the
  previous user's notifications.
- **Delivery** -- `NotificationsService.notifyOrganization`/`createInApp`
  call `PushDispatchService.dispatch`, fire-and-forget. It sends only to
  users whose `NotificationPreference.push` is `true` for that category
  (default false: opt-in), independent of `inApp`. One job per device on
  its own `push` queue (the `notifications` queue's processor completes
  unknown job names, so push cannot share it). `PushDeliveryProcessor`
  sends via `FcmPushProvider` and writes `MessageLog` (`recipient:
  device:<id>`, never the token). A dead token (UNREGISTERED,
  SENDER_ID_MISMATCH) deactivates the device instead of retrying; a
  transient failure retries with backoff and is logged FAILED only on the
  last attempt. A notification's `dedupeKey` becomes the job id, so a
  repeated event does not buzz the phone twice.
- **Members** -- `MemberPushListener` turns domain events into pushes on
  the member's own login's devices (`MemberPushService`), with the
  member's wording and portal links: membership started/cancelled,
  check-in (a receipt, and the first sign of a borrowed credential),
  payment and refund, workout and diet plan assigned, PT session booked
  and cancelled. `MembershipRenewalScanner` adds "ends in 7/3/1 days" --
  including for members with no email, whom the renewal email skips.
  Only the six member-facing categories send; no preference row means
  on (what the portal shows), `push: false` mutes. A member is not
  pushed about something they did themselves in the portal. Not pushed:
  workout sessions and PT completions -- the member was there.
- **Staff message, channel PUSH** -- `MemberDirectPushService`. A push a
  member of staff writes on the member profile goes to that member's own
  app devices, synchronously, one `MessageLog` row per device. It used to
  go through `CommunicationsService` with the member's *phone number* as
  the FCM token, so it could only fail. No app login, no active device,
  or push unconfigured each answer with a plain message instead.

## What's still a stub

- **This queue carries email only.** Push has its own queue (above);
  WhatsApp and SMS go through `CommunicationsService` directly.
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
