# members

Gym client CRUD plus the Member 360 collection/history layer.

## What exists

- `MembersController`/`MembersService` — `Member` CRUD (`primaryBranchId`, `status`,
  `assignedTrainerId`, and single denormalized `addressLine1`/`emergencyContactName`/`notes`
  fields), gated by `members.read`/`members.read_assigned` (assignment-scoped for TRAINER — see
  `docs/security/overview.md`) and `members.create`/`update`/`delete`.
- `MemberDetailsController`/`MemberDetailsService` — nested under `/members/:memberId/...`:
  - `addresses`, `emergency-contacts` — full CRUD collections (a member can have more than one;
    marking one `isPrimary` demotes the previous primary in the same transaction).
  - `notes` — an authored, timestamped collection replacing the old single overwritable
    `Member.notes` field. Only the author may edit/delete their own note (service-enforced).
  - `consents` — append-only (`POST` only, no `PATCH`/`DELETE`); revoking a consent means posting a
    new row with `granted: false`, never mutating the original grant.
- `MembersService.getStatusHistory()`/`getBranchHistory()`/`getTrainerHistory()` — read-only,
  exposed as `GET /members/:id/status-history` etc. Rows are written automatically inside
  `create()`/`update()` whenever `status`/`primaryBranchId`/`assignedTrainerId` actually changes
  (and seeded on creation, so the *original* value is in history too, not just later changes) —
  there is no direct write endpoint for these three tables.
- `MemberAssessmentsController`/`MemberAssessmentsService` — nested under
  `/members/:memberId/...`:
  - `assessments` — the parent record for an assessment session (`type`: `INITIAL`/`PROGRESS`/
    `PAR_Q`/`FITNESS_TEST`/`CUSTOM`, `conductedByUserId`, `conductedAt`).
  - `measurements` — body measurements/composition at a point in time, every entry a new row
    (never an update), optionally linked to an `assessmentId` (rejected with `404` if the id
    belongs to a different member — see `assertAssessmentBelongsToMember`).
  - `fitness-tests` — free-text `testName` (e.g. "1RM Bench Press") + `value`/`unit`, same
    optional-assessment-link pattern. Free text, not an enum, since the set of tests a gym runs is
    inherently open-ended.
  - `screenings` — PAR-Q-style health screening; `responses` is a plain JSON object
    (question-key → boolean) rather than its own table.
- `MemberGoalsController`/`MemberGoalsService` — `/members/:memberId/goals` (+ nested
  `/goals/:goalId/milestones`). A goal's `status` (`ACTIVE`/`ACHIEVED`/`ABANDONED`/`PAUSED`) is
  mutable via `PATCH`; milestones are the goal's own progress trail, so (unlike
  status/branch/trainer above) there's no separate `MemberGoalHistory` table — the milestone list
  already is the history.

Every sub-resource method re-runs `MembersService.getOne()` (tenant + branch + assignment scoping)
before touching its own table, rather than trusting a bare `memberId` — see
`test/member-360.e2e-spec.ts` and `test/member-assessments-goals.e2e-spec.ts`'s cross-tenant
isolation tests for the regression check.

## Deliberate scope limits (read before extending this module)

- **`Member`'s own address/emergency-contact/notes fields are untouched.** They remain the
  "current primary" denormalized snapshot for quick display; the collections above are additive,
  not a migration of those fields. No backfill job copies old data into the new tables.
- **No separate permission tier for notes/consents.** Everything here is gated by the same
  `members.read`/`members.read_assigned`/`members.update` as the parent `Member` — the master
  spec's "reception sees basic info, trainer sees training info" sensitivity split (§7) isn't
  applied within Member 360 sub-resources yet.
- **Documents and progress photos are not built.** They need the `files/` object-storage seam
  first (still a stub) — see `docs/architecture/discovery-report.md`'s roadmap. This is why
  `MemberAssessment` has no photo attachment field even though the master spec calls for progress
  photos alongside assessments.
- **Appointments are not built.** A separate future domain, not a sub-resource of this module.
- **No unified activity timeline.** Aggregating `MemberStatusHistory`/`MemberBranchHistory`/
  `MemberTrainerHistory`/`MemberNote`/`MemberGoal`/`Membership`/`Attendance`/... into one feed is
  real future work, not attempted here.
