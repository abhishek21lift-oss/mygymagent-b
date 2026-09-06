# PT Packages v1

PT package management is the next commercial layer over `PtSession`.

Scope:
- package templates owned by an organization
- member package purchases/assignments
- session allowance and consumption ledger
- validity dates and lifecycle status
- remaining-session queries for PT OS and analytics

Design rule: existing `PtSession` remains the source of truth for scheduled sessions; package consumption is recorded separately and only consumed for completed sessions.