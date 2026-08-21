# crm

**Status: partially implemented (v1 scope).** The lead pipeline, follow-ups,
and lead-to-member conversion are real. Campaigns and referrals (also
mentioned in the original description) are deferred -- neither has value
without a working pipeline to attach to, and building them speculatively
now would be guessing at a shape before the pipeline itself has been used.

## What exists

- `GET/POST /leads`, `GET/PATCH /leads/:id` (`leads.read`/`leads.manage`) --
  create and manage leads. List is filterable by `status`/`assignedToUserId`.
- `PATCH /leads/:id/status` (`leads.manage`) -- move a lead through
  `NEW -> CONTACTED -> QUALIFIED -> TRIAL -> LOST`. `WON` is deliberately
  excluded here -- it's set only by `/convert`, so "WON" and "has a linked
  Member" can never drift apart (see the `Lead` model's schema comment).
- `POST /leads/:id/convert` (`leads.manage`) -- creates a real `Member` from
  the lead's info via `MembersService.create()` (the same path `POST
  /members` uses, not duplicated logic), links `Lead.convertedMemberId`,
  and sets status to `WON`.
- `POST /leads/:id/follow-ups`, `PATCH /leads/:id/follow-ups/:id/complete`
  (`leads.manage`) -- scheduled follow-up tasks against a lead. Reachable
  only nested under their lead (no standalone global follow-up list) -- a
  follow-up has no meaning detached from the lead it's about.

Every query/mutation is scoped by `organizationId` taken from
`@CurrentUser()`, same as every other implemented module.

## What's still missing

- No campaigns (bulk outreach, email/SMS sequences).
- No referral tracking (member refers a friend -> becomes a lead).
- No automatic lead scoring -- see `docs/ai/architecture.md`'s
  `LeadScoreSchema`, which will call into this module's data once the `ai`
  module exists, not the other way around.
- No lead source analytics/reporting.
