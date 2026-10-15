-- D-DB01 (F-DB01): member history preservation.
--
-- Every table that points at members used to declare `ON DELETE CASCADE`,
-- so a single hard `DELETE FROM members` (a future endpoint, an admin
-- script, a GDPR erasure job) would silently wipe that member's payments,
-- invoices, attendance, memberships, PT packages, and all other history --
-- contradicting the "immutable financial record" convention on Payment and
-- Refund. The API itself only soft-deletes members
-- (members.service.ts remove(): deletedAt + INACTIVE, no prisma.member.delete
-- anywhere in src/), so this migration changes no live behavior today. It
-- converts the schema-level footgun into a fail-closed guard: any future
-- hard delete with surviving children is rejected by the database.
--
-- Safety: constraint rewrites only. No rows are read, written, or backfilled,
-- so this is safe on populated databases. Each statement drops the prior
-- constraint idempotently (IF EXISTS, the B-P0-12a lesson: statements must
-- survive re-application against databases whose history diverged) and
-- re-adds it with identical columns and ON UPDATE, changing only ON DELETE
-- to RESTRICT. Tables created by raw SQL (loyalty_accounts, loyalty_ledger,
-- referrals, marketing_campaign_members, notification_devices) carry the
-- PostgreSQL auto-generated constraint names ({table}_{column}_fkey over the
-- snake_case columns from 20260923000000_remaining_business_os); class_bookings
-- keeps its explicit map: name. ON UPDATE is preserved per constraint
-- (CASCADE default; NO ACTION where the schema declares onUpdate: NoAction).
--
-- Locking: each ALTER takes a brief ACCESS EXCLUSIVE lock on its table.
-- Deploy in a normal maintenance window; on lock-timeout failure the
-- statement fails without touching data -- retry, do not hand-edit.
-- Rollback: a follow-up migration flipping these 38 constraints back to
-- CASCADE (reverse of the statements below). No data migration is involved
-- in either direction.

-- Member-scoped profile/history rows (ON UPDATE CASCADE preserved).
ALTER TABLE "member_otp_challenges"
  DROP CONSTRAINT IF EXISTS "member_otp_challenges_memberId_fkey",
  ADD CONSTRAINT "member_otp_challenges_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_addresses"
  DROP CONSTRAINT IF EXISTS "member_addresses_memberId_fkey",
  ADD CONSTRAINT "member_addresses_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_emergency_contacts"
  DROP CONSTRAINT IF EXISTS "member_emergency_contacts_memberId_fkey",
  ADD CONSTRAINT "member_emergency_contacts_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_notes"
  DROP CONSTRAINT IF EXISTS "member_notes_memberId_fkey",
  ADD CONSTRAINT "member_notes_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_consents"
  DROP CONSTRAINT IF EXISTS "member_consents_memberId_fkey",
  ADD CONSTRAINT "member_consents_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_status_history"
  DROP CONSTRAINT IF EXISTS "member_status_history_memberId_fkey",
  ADD CONSTRAINT "member_status_history_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_branch_history"
  DROP CONSTRAINT IF EXISTS "member_branch_history_memberId_fkey",
  ADD CONSTRAINT "member_branch_history_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_trainer_history"
  DROP CONSTRAINT IF EXISTS "member_trainer_history_memberId_fkey",
  ADD CONSTRAINT "member_trainer_history_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Memberships, attendance, financial ledger (ON UPDATE CASCADE preserved).
ALTER TABLE "memberships"
  DROP CONSTRAINT IF EXISTS "memberships_memberId_fkey",
  ADD CONSTRAINT "memberships_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendances"
  DROP CONSTRAINT IF EXISTS "attendances_memberId_fkey",
  ADD CONSTRAINT "attendances_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "payments_memberId_fkey",
  ADD CONSTRAINT "payments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "invoices_memberId_fkey",
  ADD CONSTRAINT "invoices_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pt_sessions"
  DROP CONSTRAINT IF EXISTS "pt_sessions_memberId_fkey",
  ADD CONSTRAINT "pt_sessions_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pt_packages"
  DROP CONSTRAINT IF EXISTS "pt_packages_memberId_fkey",
  ADD CONSTRAINT "pt_packages_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_promises"
  DROP CONSTRAINT IF EXISTS "payment_promises_memberId_fkey",
  ADD CONSTRAINT "payment_promises_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Training, nutrition, assessment, document, scheduling history (ON UPDATE CASCADE preserved).
ALTER TABLE "workout_assignments"
  DROP CONSTRAINT IF EXISTS "workout_assignments_memberId_fkey",
  ADD CONSTRAINT "workout_assignments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workout_sessions"
  DROP CONSTRAINT IF EXISTS "workout_sessions_memberId_fkey",
  ADD CONSTRAINT "workout_sessions_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "diet_assignments"
  DROP CONSTRAINT IF EXISTS "diet_assignments_memberId_fkey",
  ADD CONSTRAINT "diet_assignments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_assessments"
  DROP CONSTRAINT IF EXISTS "member_assessments_memberId_fkey",
  ADD CONSTRAINT "member_assessments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_measurements"
  DROP CONSTRAINT IF EXISTS "member_measurements_memberId_fkey",
  ADD CONSTRAINT "member_measurements_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_fitness_test_results"
  DROP CONSTRAINT IF EXISTS "member_fitness_test_results_memberId_fkey",
  ADD CONSTRAINT "member_fitness_test_results_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_screenings"
  DROP CONSTRAINT IF EXISTS "member_screenings_memberId_fkey",
  ADD CONSTRAINT "member_screenings_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_goals"
  DROP CONSTRAINT IF EXISTS "member_goals_memberId_fkey",
  ADD CONSTRAINT "member_goals_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_documents"
  DROP CONSTRAINT IF EXISTS "member_documents_memberId_fkey",
  ADD CONSTRAINT "member_documents_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments"
  DROP CONSTRAINT IF EXISTS "appointments_memberId_fkey",
  ADD CONSTRAINT "appointments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Engagement, QR/device, intelligence rows (ON UPDATE CASCADE preserved).
ALTER TABLE "member_qr_tokens"
  DROP CONSTRAINT IF EXISTS "member_qr_tokens_memberId_fkey",
  ADD CONSTRAINT "member_qr_tokens_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_maps"
  DROP CONSTRAINT IF EXISTS "device_maps_memberId_fkey",
  ADD CONSTRAINT "device_maps_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_tag_assignments"
  DROP CONSTRAINT IF EXISTS "member_tag_assignments_memberId_fkey",
  ADD CONSTRAINT "member_tag_assignments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_follow_ups"
  DROP CONSTRAINT IF EXISTS "member_follow_ups_memberId_fkey",
  ADD CONSTRAINT "member_follow_ups_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_risk_profiles"
  DROP CONSTRAINT IF EXISTS "member_risk_profiles_memberId_fkey",
  ADD CONSTRAINT "member_risk_profiles_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_segment_assignments"
  DROP CONSTRAINT IF EXISTS "member_segment_assignments_memberId_fkey",
  ADD CONSTRAINT "member_segment_assignments_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recommended_actions"
  DROP CONSTRAINT IF EXISTS "recommended_actions_memberId_fkey",
  ADD CONSTRAINT "recommended_actions_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw-SQL tables: ON UPDATE NO ACTION preserved (matches schema onUpdate: NoAction).
ALTER TABLE "loyalty_accounts"
  DROP CONSTRAINT IF EXISTS "loyalty_accounts_member_id_fkey",
  ADD CONSTRAINT "loyalty_accounts_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "loyalty_ledger"
  DROP CONSTRAINT IF EXISTS "loyalty_ledger_member_id_fkey",
  ADD CONSTRAINT "loyalty_ledger_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referrals"
  DROP CONSTRAINT IF EXISTS "referrals_referrer_member_id_fkey",
  ADD CONSTRAINT "referrals_referrer_member_id_fkey"
    FOREIGN KEY ("referrer_member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "marketing_campaign_members"
  DROP CONSTRAINT IF EXISTS "marketing_campaign_members_member_id_fkey",
  ADD CONSTRAINT "marketing_campaign_members_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "notification_devices"
  DROP CONSTRAINT IF EXISTS "notification_devices_member_id_fkey",
  ADD CONSTRAINT "notification_devices_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "class_bookings"
  DROP CONSTRAINT IF EXISTS "class_bookings_member_fkey",
  ADD CONSTRAINT "class_bookings_member_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
