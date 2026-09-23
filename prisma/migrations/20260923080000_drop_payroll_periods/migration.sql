-- B-P0-6: one pay-cycle object, not two.
--
-- `payroll_periods` modelled the same thing `payroll_runs` does -- a dated
-- window with a status -- but knew nothing about branches, approvers,
-- processing or line items. Its only behaviour was to approve the trainer
-- commissions falling inside its window, which is now part of processing a
-- payroll run, inside the same transaction that finalizes that run's items.
--
-- Nothing read this table: no frontend call site, and no test before the
-- one added with this change. A faithful backfill into `payroll_runs` is
-- not possible -- a run requires `createdByUserId` and a period never
-- recorded an author -- so rather than invent one, any OPEN period is
-- reported here and the table is dropped. Commissions themselves are
-- untouched; an unapproved one simply waits for the next payroll run
-- covering its window.
DO $$
DECLARE open_periods integer;
BEGIN
  SELECT count(*) INTO open_periods FROM payroll_periods WHERE status = 'OPEN';
  IF open_periods > 0 THEN
    RAISE NOTICE 'Dropping payroll_periods with % OPEN period(s); their commissions stay PENDING until a payroll run covers the window.', open_periods;
  END IF;
END $$;

-- DropTable
DROP TABLE IF EXISTS payroll_periods;
