CREATE TABLE cp_material_action_receipt (
  organization_id text NOT NULL,
  receipt_id text NOT NULL,
  operation_id text NOT NULL,
  run_id text NOT NULL,
  runner_id text NOT NULL,
  attempt_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  action_id text NOT NULL,
  receipt_digest text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'outcome_unknown')),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, receipt_id),
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, receipt_digest),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES cp_hosted_run(organization_id, run_id),
  FOREIGN KEY (organization_id, run_id, attempt_number)
    REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number)
);

CREATE TABLE cp_material_action_current (
  organization_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  action_id text NOT NULL,
  receipt_id text NOT NULL,
  receipt_digest text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'outcome_unknown')),
  receipt jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, run_id, attempt_id, action_id),
  FOREIGN KEY (organization_id, receipt_id)
    REFERENCES cp_material_action_receipt(organization_id, receipt_id)
);

CREATE INDEX cp_material_action_run_idx
  ON cp_material_action_receipt(organization_id, run_id, created_at, receipt_id);
