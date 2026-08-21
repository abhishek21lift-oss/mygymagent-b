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
- `MemberDocumentsController`/`MemberDocumentsService` — `/members/:memberId/documents`
  (multipart upload via `FileInterceptor`). Backed by `FileStorageService` (`src/files/`) —
  MIME-type allowlist + 10MB size cap enforced before anything reaches storage; every read returns
  a signed URL generated fresh per request, never a stored/permanent one. `category` (`DOCUMENT`/
  `PROGRESS_PHOTO`/`ID_SCAN`/`OTHER`) is a field on the same table, not a separate resource per
  category — "progress photo" and "document" are the same shape (an uploaded file attached to a
  member), so they don't need separate tables/endpoints.

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
- **`MemberAssessment` still has no photo attachment field.** Progress photos are their own
  `MemberDocument` rows (category=`PROGRESS_PHOTO`), not linked to a specific assessment session
  the way measurements/fitness-tests/screenings optionally are — associating a progress photo with
  a specific assessment is real future work, not attempted here.
- **Appointments are not built.** A separate future domain, not a sub-resource of this module.
- **No unified activity timeline.** Aggregating `MemberStatusHistory`/`MemberBranchHistory`/
  `MemberTrainerHistory`/`MemberNote`/`MemberGoal`/`Membership`/`Attendance`/... into one feed is
  real future work, not attempted here.
