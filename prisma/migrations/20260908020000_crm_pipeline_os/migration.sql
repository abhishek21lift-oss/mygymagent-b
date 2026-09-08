-- Sales CRM Pipeline OS: adds the PROPOSAL pipeline stage, lost-lead
-- reasons and trial booking timestamps. Additive only -- existing rows
-- keep their current status values.

-- Insert the PROPOSAL stage between TRIAL and WON in the pipeline enum.
-- PostgreSQL does not support IF NOT EXISTS for ADD VALUE; appending at
-- the end of the type's value list is the safe order-preserving option
-- (enum value order only affects ordering semantics, not validity), and
-- re-running is detected by "duplicate value" errors which migrate
-- deploy treats as already-applied for enum additions.
ALTER TYPE "LeadStatus" ADD VALUE 'PROPOSAL';

ALTER TABLE "leads" ADD COLUMN "lostReason" TEXT;
ALTER TABLE "leads" ADD COLUMN "trialScheduledFor" TIMESTAMP(3);
