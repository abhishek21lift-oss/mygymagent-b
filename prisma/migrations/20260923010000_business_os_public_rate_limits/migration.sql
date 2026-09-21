-- Distributed rate limiting for public Business OS endpoints.
CREATE TABLE IF NOT EXISTS public_endpoint_rate_limits (
  scope text NOT NULL,
  key text NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS public_endpoint_rate_limits_window_idx
  ON public_endpoint_rate_limits(window_started_at);
