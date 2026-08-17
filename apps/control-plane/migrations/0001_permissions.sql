CREATE TABLE cp_permission_request (
  organization_id text NOT NULL,
  permission_request_id text NOT NULL,
  run_id text NOT NULL,
  runner_id text NOT NULL,
  attempt_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  action_id text NOT NULL,
  resolution_id text NOT NULL,
  permission_request_digest text NOT NULL,
  policy_snapshot_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting', 'authorized', 'denied')),
  request jsonb NOT NULL,
  current_receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, permission_request_id),
  UNIQUE (organization_id, run_id, attempt_id, action_id),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES cp_hosted_run(organization_id, run_id),
  FOREIGN KEY (organization_id, run_id, attempt_number)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number)
);

CREATE TABLE cp_permission_operation (
  organization_id text NOT NULL,
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  permission_request_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('request', 'decision')),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, permission_request_id)
    REFERENCES cp_permission_request(organization_id, permission_request_id)
);

CREATE INDEX cp_permission_current_idx
  ON cp_permission_request(organization_id, run_id, state, updated_at DESC);
