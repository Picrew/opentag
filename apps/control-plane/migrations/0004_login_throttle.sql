CREATE TABLE cp_login_throttle (
  throttle_key text PRIMARY KEY,
  failure_count integer NOT NULL CHECK (failure_count > 0),
  window_started_at timestamptz NOT NULL,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE INDEX cp_login_throttle_locked_until_idx
  ON cp_login_throttle(locked_until)
  WHERE locked_until IS NOT NULL;

CREATE INDEX cp_login_throttle_updated_at_idx
  ON cp_login_throttle(updated_at);
