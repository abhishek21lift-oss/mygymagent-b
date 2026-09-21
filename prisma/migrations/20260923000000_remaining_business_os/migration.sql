-- MyGymAgent remaining business OS
CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  tier text NOT NULL DEFAULT 'STANDARD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, member_id)
);
CREATE INDEX IF NOT EXISTS loyalty_accounts_org_idx ON loyalty_accounts(organization_id);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  points integer NOT NULL,
  reason text NOT NULL,
  reference_type text,
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_ledger_org_member_idx ON loyalty_ledger(organization_id, member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referrer_member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  referred_member_id text REFERENCES members(id) ON DELETE SET NULL,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  reward_points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id text REFERENCES branches(id) ON DELETE SET NULL,
  member_id text REFERENCES members(id) ON DELETE SET NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id text REFERENCES users(id) ON DELETE SET NULL,
  subject text NOT NULL,
  description text NOT NULL,
  category text NOT NULL DEFAULT 'GENERAL',
  priority text NOT NULL DEFAULT 'NORMAL',
  status text NOT NULL DEFAULT 'OPEN',
  sla_due_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_org_status_idx ON support_tickets(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id text NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id text REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_surveys (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'CSAT',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_responses (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  survey_id text NOT NULL REFERENCES feedback_surveys(id) ON DELETE CASCADE,
  member_id text REFERENCES members(id) ON DELETE SET NULL,
  score integer NOT NULL CHECK (score >= 0 AND score <= 10),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_responses_org_idx ON feedback_responses(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id text REFERENCES branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  channel text NOT NULL DEFAULT 'EMAIL',
  template_key text,
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'DRAFT',
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_campaigns_org_idx ON marketing_campaigns(organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_campaign_members (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'QUEUED',
  sent_at timestamptz,
  error text,
  UNIQUE (campaign_id, member_id)
);

CREATE TABLE IF NOT EXISTS accounting_accounts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS accounting_entries (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
  branch_id text REFERENCES branches(id) ON DELETE SET NULL,
  reference_type text,
  reference_id text,
  debit numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description text NOT NULL,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX IF NOT EXISTS accounting_entries_org_date_idx ON accounting_entries(organization_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS portal_invites (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kiosk_devices (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kiosk_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  device_id text REFERENCES kiosk_devices(id) ON DELETE SET NULL,
  member_id text REFERENCES members(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_devices (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_id text REFERENCES members(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  address text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_devices_org_idx ON notification_devices(organization_id, channel, active);

CREATE TABLE IF NOT EXISTS ai_command_logs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  command text NOT NULL,
  response_type text NOT NULL,
  tool_name text,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
