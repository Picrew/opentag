CREATE TABLE cp_organization (
  organization_id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE cp_operator (
  operator_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz
);

CREATE TABLE cp_membership (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  operator_id text NOT NULL REFERENCES cp_operator(operator_id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, operator_id)
);

CREATE TABLE cp_session (
  session_id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES cp_operator(operator_id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);

CREATE TABLE cp_api_key (
  api_key_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scope text[] NOT NULL,
  created_by text NOT NULL REFERENCES cp_operator(operator_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);

CREATE TABLE cp_runner (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  runner_id text NOT NULL,
  display_name text,
  registration_generation integer NOT NULL CHECK (registration_generation > 0),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  current_credential_id text NOT NULL,
  capabilities jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, runner_id),
  UNIQUE (organization_id, current_credential_id)
);

CREATE TABLE cp_runner_credential (
  organization_id text NOT NULL,
  runner_id text NOT NULL,
  credential_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, credential_id),
  UNIQUE (organization_id, runner_id, credential_generation),
  FOREIGN KEY (organization_id, runner_id)
    REFERENCES cp_runner(organization_id, runner_id)
);

CREATE TABLE cp_runner_operation (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  operation_id text NOT NULL,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  operation_kind text NOT NULL,
  runner_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation_id)
);

CREATE TABLE cp_runner_readiness (
  organization_id text NOT NULL,
  runner_id text NOT NULL,
  receipt_id text NOT NULL,
  receipt_digest text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, receipt_id),
  UNIQUE (organization_id, runner_id, receipt_digest),
  FOREIGN KEY (organization_id, runner_id)
    REFERENCES cp_runner(organization_id, runner_id)
);

CREATE INDEX cp_runner_readiness_current_idx
  ON cp_runner_readiness(organization_id, runner_id, observed_at DESC);

CREATE TABLE cp_project_target (
  organization_id text NOT NULL,
  project_target_id text NOT NULL,
  runner_id text NOT NULL,
  binding_digest text NOT NULL,
  provider text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  default_executor text NOT NULL,
  default_branch text,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, project_target_id),
  FOREIGN KEY (organization_id, runner_id)
    REFERENCES cp_runner(organization_id, runner_id)
);

CREATE TABLE cp_hosted_run (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  run_id text NOT NULL,
  admission_id text NOT NULL,
  admission_operation_id text NOT NULL,
  admission_digest text NOT NULL,
  source_identity_digest text NOT NULL,
  runner_id text NOT NULL,
  executor_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'running', 'cancelled', 'completed', 'rejected')),
  current_attempt_number integer NOT NULL DEFAULT 0 CHECK (current_attempt_number >= 0),
  terminal_kind text CHECK (terminal_kind IN ('cancelled', 'completed', 'rejected')),
  terminal_receipt jsonb,
  hosted_admission jsonb NOT NULL,
  admission_policy_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, run_id),
  UNIQUE (organization_id, admission_id),
  UNIQUE (organization_id, source_identity_digest),
  FOREIGN KEY (organization_id, runner_id)
    REFERENCES cp_runner(organization_id, runner_id),
  CHECK ((terminal_kind IS NULL) = (terminal_receipt IS NULL))
);

CREATE INDEX cp_hosted_run_claim_idx
  ON cp_hosted_run(organization_id, runner_id, state, created_at);

CREATE TABLE cp_hosted_attempt (
  organization_id text NOT NULL,
  run_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  attempt_id text NOT NULL,
  runner_id text NOT NULL,
  credential_id text NOT NULL,
  fencing_token_digest text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed', 'running', 'cancelled', 'completed', 'rejected', 'expired')),
  claimed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, run_id, attempt_number),
  UNIQUE (organization_id, attempt_id),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES cp_hosted_run(organization_id, run_id)
);

CREATE TABLE cp_hosted_claim (
  organization_id text NOT NULL,
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  run_id text NOT NULL,
  claim jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES cp_hosted_run(organization_id, run_id)
);

CREATE TABLE cp_hosted_lifecycle_receipt (
  organization_id text NOT NULL,
  operation_id text NOT NULL,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('heartbeat', 'running', 'progress', 'reject_start', 'executor_result', 'cancel')),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation_id),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES cp_hosted_run(organization_id, run_id)
);

CREATE TABLE cp_hosted_audit_event (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL,
  run_id text NOT NULL,
  event_kind text NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, run_id)
    REFERENCES cp_hosted_run(organization_id, run_id)
);

CREATE INDEX cp_hosted_audit_run_idx
  ON cp_hosted_audit_event(organization_id, run_id, sequence_id);

CREATE TABLE cp_management_audit_event (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  operation_kind text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX cp_management_audit_tenant_idx
  ON cp_management_audit_event(organization_id, sequence_id);

CREATE TABLE cp_github_binding (
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  binding_id text NOT NULL,
  provider_repository_id text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  runner_id text NOT NULL,
  project_target_id text NOT NULL,
  secret_hash text NOT NULL,
  secret_version text NOT NULL,
  allowed_actor_ids text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, binding_id),
  UNIQUE (binding_id),
  UNIQUE (organization_id, provider_repository_id),
  FOREIGN KEY (organization_id, runner_id)
    REFERENCES cp_runner(organization_id, runner_id)
);

CREATE TABLE cp_github_delivery (
  organization_id text NOT NULL,
  binding_id text NOT NULL,
  delivery_id text NOT NULL,
  payload_digest text NOT NULL,
  event_name text NOT NULL,
  normalized_outcome jsonb NOT NULL,
  processing_token text,
  processing_expires_at timestamptz,
  received_at timestamptz NOT NULL,
  CHECK (
    (normalized_outcome = '{"kind":"processing"}'::jsonb
      AND processing_token IS NOT NULL
      AND processing_expires_at IS NOT NULL)
    OR
    (normalized_outcome <> '{"kind":"processing"}'::jsonb
      AND processing_token IS NULL
      AND processing_expires_at IS NULL)
  ),
  PRIMARY KEY (organization_id, binding_id, delivery_id),
  FOREIGN KEY (organization_id, binding_id)
    REFERENCES cp_github_binding(organization_id, binding_id)
);

CREATE TABLE cp_provider_evidence (
  evidence_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES cp_organization(organization_id),
  run_id text,
  provider text NOT NULL,
  evidence_kind text NOT NULL,
  provider_identity text NOT NULL,
  payload_digest text NOT NULL,
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  UNIQUE (organization_id, provider, evidence_kind, provider_identity)
);

CREATE TABLE cp_job (
  job_id text PRIMARY KEY,
  organization_id text REFERENCES cp_organization(organization_id),
  job_kind text NOT NULL,
  payload jsonb NOT NULL,
  request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'succeeded', 'failed')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (state = 'claimed' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'claimed')
  )
);

CREATE INDEX cp_job_claim_idx ON cp_job(state, available_at, created_at);

CREATE TABLE cp_job_settlement (
  job_id text PRIMARY KEY REFERENCES cp_job(job_id),
  lease_token text NOT NULL,
  outcome jsonb NOT NULL,
  settled_at timestamptz NOT NULL
);
