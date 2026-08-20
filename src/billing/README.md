# billing

**Status: partially implemented.** Payments and refunds are real
(`PaymentsController`/`PaymentsService`, backed by the `Payment`/`Refund`
tables). Invoices, discounts, taxes, and trainer payouts/commissions
described in `docs/ARCHITECTURE.md#billing-architecture` are still not
built.

This is gym **operational** billing (a member paying the gym) — not
platform billing (the gym paying this SaaS), which is a separate,
not-yet-built model family. See `docs/saas/billing-separation.md`.

## What exists

- `POST /payments` — record a payment (`payments.create`). Optionally
  linked to a `Membership`; otherwise a one-off charge (PT session,
  product, walk-in fee).
- `GET /payments`, `GET /payments/:id` — list/view (`payments.read`),
  filterable by `memberId`/`membershipId`.
- `POST /payments/:id/refund` — issue a full or partial refund
  (`payments.refund`). Never mutates the original `Payment.amount` — see
  `docs/database/data-retention.md`'s financial-records section. A payment
  can be refunded multiple times (partial refunds) up to its original
  amount; `Payment.status` tracks `COMPLETED` → `PARTIALLY_REFUNDED` →
  `REFUNDED`.

Every query/mutation is scoped by `organizationId` taken from
`@CurrentUser()`, same as every other implemented module — see
`test/tenant-isolation.e2e-spec.ts`'s payments case.

## What's still missing

- No payment gateway integration — payments are staff-recorded (cash/card/
  UPI/bank transfer logged after the fact), not processed through Razorpay/
  Stripe/etc. That's `docs/integrations/overview.md`'s `PaymentProcessor`
  adapter, not built yet.
- No invoices, discounts, or tax handling.
- No trainer payout/commission calculation (`StaffProfile.commissionRate`
  exists on the schema but nothing computes against it yet).
- No platform billing (SaaS subscription) — see `docs/saas/`.
