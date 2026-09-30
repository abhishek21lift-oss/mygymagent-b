# automation

Trigger -> Conditions -> Action -> Audit. Scans run as BullMQ repeatable jobs
(`AutomationSchedulerService`); a few automations are event-driven. Every attempt writes an
`AutomationRun` row, and `AutomationRunService.attempt()` uses those rows for cooldowns. A FAILED
run never uses up a cooldown.

## What runs

| Automation | When | Who | Channel | Once per |
|---|---|---|---|---|
| Renewal reminder | Daily 08:00 UTC; ACTIVE membership ending within 7 days, member has no later membership | Member | **WhatsApp** (`renewal.t7` / `t3` / `t0`) else email | WhatsApp: each stage once (>3 days, 2-3 days, the last day). Email: every 3 days |
| Payment overdue | Daily; started ACTIVE/PENDING membership with a balance, where FAILED payments count as unpaid | Member | **WhatsApp** (`payment.overdue`) else email | 5 days |
| Invoice due / overdue | Daily; windows at -3, 0, +3 and +7 days from `dueAt`, each caught up for up to 3 days if a scan misses its day; invoice set to OVERDUE at +7 | Member | **WhatsApp** (`invoice.due_soon` / `overdue` / `final_notice`) else email | Each window once |
| PT package expiry | Daily; ACTIVE package with sessions left, ending within 7 days | Member | **WhatsApp** (`pt.expiry`) else email | 3 days |
| Win-back | Daily; ACTIVE member not seen for 30+ days. MARKETING, so only with the member's consent | Member | Email only: marketing never goes from the gym's own number | Once per absence (nothing sent since the last visit) |
| Welcome | Member created | Member | **WhatsApp** (`welcome`) else email | Once |
| Receipt (front desk) | `payment.recorded` for a COMPLETED payment | Member | **WhatsApp** (`payment.received`) only | Once |
| Receipt (online) | Razorpay capture | Member | **WhatsApp** (`payment.receipt`) else email | Once |
| Lead first touch | Every 5 minutes; NEW lead with a phone, never contacted | Lead | WhatsApp (own number or Meta) | Once |
| Lead follow-up due | Daily; overdue follow-up with an assignee | Staff | Email | 1 day |
| Low stock | `inventory.low` event | Staff with `inventory.manage` | Email | 1 day per product and recipient |
| Push nudges | Renewal at 7/3/1 days, and domain events | Member's devices | Push | Deduped per event |
| Membership status | Hourly; ACTIVE past `endDate` becomes EXPIRED, and a FROZEN membership past `freezeEndDate` resumes with the booked days added | Nobody (no message) | None | Idempotent |

**WhatsApp first.** A member reminder goes on WhatsApp when the gym has linked its own number
(WhatsApp Web) and turned on "send from this number", and the member has a phone. Otherwise it
goes by email, as before. It goes on one channel, not both. The two channels keep separate cooldowns
(WhatsApp runs are recorded as `<subjectId>:whatsapp[:stage]`), so a failed WhatsApp send falls back
to email the same day. The Meta Cloud API is not used for these, because it only delivers
business-initiated messages as pre-approved templates. See `member-messenger.service.ts`.

**Who is never messaged:**
- gyms that are SUSPENDED, CANCELLED or deleted (`automation-scope.ts`);
- soft-deleted members;
- a member whose next membership is already sold.

Dates are written the gym's way, in its timezone ("14 Oct 2026"), and amounts in its currency
("₹2,500").

**No approval step.** Every automation here sends a message about the recipient's own account.
Nothing moves money or deletes anything.

## Known simplifications

- **Payment overdue is a computed outstanding balance, not an invoice system.** This schema has no
  accounts-receivable/invoice model -- `Payment` rows only exist once money has actually been
  collected. "Overdue" here means `membership.price - (payments - refunds) > 0` for a membership
  whose `startDate` has passed, not "N days past a due date," because there is no due-date concept
  to be N days past. Honest about what it actually knows.
- **Low-stock alert recipients** are every user in the org holding `inventory.manage` through a
  role grant (see `AutomationScanProcessor.sendLowStockAlert()`'s comment) -- doesn't apply a
  per-user DENY override the way `PermissionsService.hasPermission()` does for a live request.
  Acceptable for an internal stock alert; would need fixing before this pattern is reused for
  anything higher-stakes.
- **Fixed daily schedule (08:00 UTC -- 13:30 in India), same for every org.** No per-org timezone/schedule
  configuration -- not asked for by the master prompt's P1 scope, and there's nowhere in the
  schema to store it yet.
- **Inactive-member recovery threshold (30 days) and all cooldowns are fixed constants**, not
  per-org configurable. Same reasoning as the schedule.

## Tested

`test/automation.e2e-spec.ts` -- against real Postgres, real Redis (BullMQ), and real SMTP (see
`test/utils/smtp-capture-server.ts`): each scanner's trigger condition, its cooldown suppressing a
second run, the payment-overdue balance calculation from real Payment/Refund rows, the
MARKETING-consent SKIPPED path for inactive-member recovery, and the real-time inventory-low event
-> queue -> email path end to end.

`test/automation-whatsapp.e2e-spec.ts` covers the WhatsApp-first path against a fake WhatsApp socket:
- renewal stages sent once each, with readable dates and no leftover `{{…}}`;
- falling back to email when there is no phone;
- renewed and deleted members, and suspended gyms, left alone;
- a declined card counted as unpaid, with the amount in rupees;
- a missed dunning day caught up, once;
- win-back once per absence;
- the WhatsApp welcome and desk receipt;
- the automation screen's WhatsApp flags.

Removing any one of those fixes turns a test red.

## WhatsApp auto-replies

`whatsapp-auto-reply.listener.ts` answers a member's WhatsApp message on its own, through the gym's
linked number, while `WhatsappWebSession.autoReply` is on (default; Settings → WhatsApp). The
welcome message invites replies; before this, nobody answered them until staff looked.

Keywords (English and Hinglish, `whatsapp-auto-reply.intents.ts`) pick the answer, built from the
gym's own data: **PLANS** (active plans and prices), **TIMINGS** (each branch's opening hours from
Settings → Gym profile), **CLASSES** (next 7 days), **MY PLAN** (the member's own membership and
renew link), **CONTACT** (branch address, phone and directions link), **HI/HELP** (the menu). Anything else gets "our team will reply soon" once in 12 hours; "thanks"/"ok" gets nothing.

Guards: at most 6 answers an hour to one number, the same answer not twice within 2 minutes, and no
"we'll reply" while staff wrote to that person from the app in the last 30 minutes. Answers are
logged as `auto_reply.<intent>`; every inbound message still reaches the inbox. Tested in
`test/whatsapp-auto-reply.e2e-spec.ts`.
