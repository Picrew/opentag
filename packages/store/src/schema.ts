import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";


export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    status: text("status").notNull(),
    eventJson: text("event_json").notNull(),
    contextPacketJson: text("context_packet_json"),
    accessProfileSnapshotJson: text("access_profile_snapshot_json"),
    policySnapshotProvenanceJson: text("policy_snapshot_provenance_json"),
    resultJson: text("result_json"),
    assignedRunnerId: text("assigned_runner_id"),
    executor: text("executor"),
    parentRunId: text("parent_run_id"),
    triggeredByActionJson: text("triggered_by_action_json"),
    sourceProposalId: text("source_proposal_id"),
    sourceApplyPlanId: text("source_apply_plan_id"),
    repoProvider: text("repo_provider"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    workThreadId: text("work_thread_id"),
    workstreamId: text("workstream_id"),
    admissionBatchId: text("admission_batch_id"),
    conversationKey: text("conversation_key"),
    leasedAt: text("leased_at"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    currentAttemptId: text("current_attempt_id"),
    currentRoutingDecisionId: text("current_routing_decision_id"),
    routingPolicyJson: text("routing_policy_json"),
    routingRunnerIdsJson: text("routing_runner_ids_json"),
    routingExecutorIdsJson: text("routing_executor_ids_json"),
    routingRejectionsJson: text("routing_rejections_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    statusIdx: index("runs_status_idx").on(table.status),
    claimQueueIdx: index("runs_claim_queue_idx").on(table.status, table.createdAt, table.id),
    leaseRecoveryIdx: index("runs_lease_recovery_idx").on(table.status, table.leaseExpiresAt, table.createdAt, table.id),
    runnerIdx: index("runs_runner_idx").on(table.assignedRunnerId),
    repoIdx: index("runs_repo_idx").on(table.repoProvider, table.repoOwner, table.repoName),
    workThreadIdx: index("runs_work_thread_idx").on(table.workThreadId),
    workThreadAuthorityIdx: index("runs_work_thread_authority_idx").on(table.workThreadId, table.createdAt, table.id),
    workstreamIdx: index("runs_workstream_idx").on(table.workstreamId, table.status),
    admissionBatchIdx: index("runs_admission_batch_idx").on(table.admissionBatchId),
    conversationIdx: index("runs_conversation_idx").on(table.conversationKey)
  })
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    number: integer("number").notNull(),
    runnerId: text("runner_id").notNull(),
    runnerLocality: text("runner_locality"),
    selectedExecutorId: text("selected_executor_id"),
    routingDecisionId: text("routing_decision_id"),
    fencingToken: text("fencing_token").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    finishedAt: text("finished_at"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    runNumberIdx: uniqueIndex("attempts_run_number_idx").on(table.runId, table.number),
    runIdx: index("attempts_run_idx").on(table.runId),
    runnerIdx: index("attempts_runner_idx").on(table.runnerId)
  })
);

export const hostedRunImports = sqliteTable(
  "hosted_run_imports",
  {
    runId: text("run_id").primaryKey(),
    admissionId: text("admission_id").notNull(),
    admissionOperationId: text("admission_operation_id").notNull(),
    claimOperationId: text("claim_operation_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    sourceIdentityDigest: text("source_identity_digest").notNull(),
    deliveryPayloadDigest: text("delivery_payload_digest").notNull(),
    admissionEnvelopeDigest: text("admission_envelope_digest").notNull(),
    policyReceiptId: text("policy_receipt_id").notNull(),
    policyPayloadDigest: text("policy_payload_digest").notNull(),
    policyReceiptDigest: text("policy_receipt_digest").notNull(),
    eventDigest: text("event_digest").notNull(),
    contextPacketDigest: text("context_packet_digest").notNull(),
    workThreadId: text("work_thread_id"),
    workThreadDigest: text("work_thread_digest"),
    claimDigest: text("claim_digest").notNull(),
    authorityDigest: text("authority_digest").notNull(),
    authorityJson: text("authority_json").notNull(),
    importedAt: text("imported_at").notNull()
  },
  (table) => ({
    admissionIdx: uniqueIndex("hosted_run_imports_admission_idx").on(table.admissionId),
    claimOperationIdx: uniqueIndex("hosted_run_imports_claim_operation_idx").on(table.claimOperationId),
    attemptIdx: uniqueIndex("hosted_run_imports_attempt_idx").on(table.attemptId),
    fenceIdx: uniqueIndex("hosted_run_imports_fence_idx").on(table.fencingTokenDigest),
    sourceIdx: uniqueIndex("hosted_run_imports_source_idx").on(table.sourceIdentityDigest),
    authorityIdx: uniqueIndex("hosted_run_imports_authority_idx").on(table.authorityDigest),
    workThreadIdx: index("hosted_run_imports_work_thread_idx").on(table.workThreadId)
  })
);

export const hostedClaimOperations = sqliteTable(
  "hosted_claim_operations",
  {
    operationId: text("operation_id").primaryKey(),
    requestId: text("request_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    destinationId: text("destination_id").notNull(),
    activeKey: text("active_key"),
    requestDigest: text("request_digest").notNull(),
    requestJson: text("request_json").notNull(),
    state: text("state").notNull(),
    runId: text("run_id"),
    claimDigest: text("claim_digest"),
    authorityDigest: text("authority_digest"),
    authorityJson: text("authority_json"),
    attemptId: text("attempt_id"),
    attemptNumber: integer("attempt_number"),
    fencingTokenDigest: text("fencing_token_digest"),
    credentialId: text("credential_id"),
    leaseExpiresAt: text("lease_expires_at"),
    executorId: text("executor_id"),
    executionStartedAt: text("execution_started_at"),
    terminalReasonCode: text("terminal_reason_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
  },
  (table) => ({
    requestIdx: uniqueIndex("hosted_claim_operations_request_idx").on(table.requestId),
    activeIdx: uniqueIndex("hosted_claim_operations_active_idx").on(table.activeKey),
    runnerStateIdx: index("hosted_claim_operations_runner_state_idx").on(
      table.destinationId,
      table.organizationId,
      table.runnerId,
      table.state
    )
  })
);

export const hostedAttemptImports = sqliteTable(
  "hosted_attempt_imports",
  {
    attemptId: text("attempt_id").primaryKey(),
    runId: text("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    claimOperationId: text("claim_operation_id").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    claimDigest: text("claim_digest").notNull(),
    authorityDigest: text("authority_digest").notNull(),
    authorityJson: text("authority_json").notNull(),
    importedAt: text("imported_at").notNull()
  },
  (table) => ({
    runNumberIdx: uniqueIndex("hosted_attempt_imports_run_number_idx").on(table.runId, table.attemptNumber),
    operationIdx: uniqueIndex("hosted_attempt_imports_operation_idx").on(table.claimOperationId),
    fenceIdx: uniqueIndex("hosted_attempt_imports_fence_idx").on(table.fencingTokenDigest),
    authorityIdx: uniqueIndex("hosted_attempt_imports_authority_idx").on(table.authorityDigest),
    runIdx: index("hosted_attempt_imports_run_idx").on(table.runId)
  })
);

export const hostedHeartbeatOperations = sqliteTable(
  "hosted_heartbeat_operations",
  {
    destinationId: text("destination_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    credentialId: text("credential_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestId: text("request_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    expectedLeaseExpiresAt: text("expected_lease_expires_at").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestJson: text("request_json").notNull(),
    activeKey: text("active_key"),
    state: text("state").notNull(),
    receiptDigest: text("receipt_digest"),
    receiptJson: text("receipt_json"),
    acceptedLeaseExpiresAt: text("accepted_lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [
      table.destinationId,
      table.organizationId,
      table.runnerId,
      table.credentialId,
      table.operationId
    ] }),
    requestIdx: uniqueIndex("hosted_heartbeat_operations_request_idx").on(
      table.destinationId,
      table.organizationId,
      table.runnerId,
      table.credentialId,
      table.requestId
    ),
    activeIdx: uniqueIndex("hosted_heartbeat_operations_active_idx").on(table.activeKey),
    attemptIdx: index("hosted_heartbeat_operations_attempt_idx").on(
      table.runId,
      table.attemptId,
      table.state
    )
  })
);

export const hostedLifecycleOperations = sqliteTable(
  "hosted_lifecycle_operations",
  {
    destinationId: text("destination_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    credentialId: text("credential_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestId: text("request_id").notNull(),
    action: text("action").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    requestDigest: text("request_digest").notNull(),
    businessKeyDigest: text("business_key_digest").notNull(),
    sequence: integer("sequence").notNull(),
    requestJson: text("request_json").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    receiptId: text("receipt_id"),
    receiptDigest: text("receipt_digest"),
    receiptJson: text("receipt_json"),
    lastReasonCode: text("last_reason_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [
      table.destinationId,
      table.organizationId,
      table.runnerId,
      table.credentialId,
      table.operationId
    ] }),
    requestIdx: uniqueIndex("hosted_lifecycle_operations_request_idx").on(
      table.destinationId,
      table.organizationId,
      table.runnerId,
      table.credentialId,
      table.requestId
    ),
    businessIdx: uniqueIndex("hosted_lifecycle_operations_business_idx").on(
      table.destinationId,
      table.organizationId,
      table.runnerId,
      table.credentialId,
      table.businessKeyDigest
    ),
    sequenceIdx: uniqueIndex("hosted_lifecycle_operations_sequence_idx").on(
      table.destinationId,
      table.organizationId,
      table.runId,
      table.attemptId,
      table.sequence
    ),
    dueIdx: index("hosted_lifecycle_operations_due_idx").on(
      table.destinationId,
      table.organizationId,
      table.state,
      table.nextAttemptAt,
      table.createdAt
    ),
    attemptIdx: index("hosted_lifecycle_operations_attempt_idx").on(
      table.runId,
      table.attemptId,
      table.state
    )
  })
);

export const followUpRequests = sqliteTable(
  "follow_up_requests",
  {
    id: text("id").primaryKey(),
    sourceEventId: text("source_event_id").notNull(),
    conversationKey: text("conversation_key").notNull(),
    activeRunId: text("active_run_id"),
    workstreamId: text("workstream_id"),
    admissionBatchId: text("admission_batch_id"),
    eventJson: text("event_json").notNull(),
    decisionJson: text("decision_json").notNull(),
    accessProfileSnapshotJson: text("access_profile_snapshot_json"),
    policySnapshotProvenanceJson: text("policy_snapshot_provenance_json"),
    routingPolicyJson: text("routing_policy_json"),
    status: text("status").notNull(),
    createdRunId: text("created_run_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    sourceEventIdx: uniqueIndex("follow_up_requests_source_event_idx").on(table.sourceEventId),
    conversationIdx: index("follow_up_requests_conversation_idx").on(table.conversationKey, table.status)
  })
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    visibility: text("visibility").notNull().default("audit"),
    importance: text("importance").notNull().default("normal"),
    message: text("message"),
    payloadJson: text("payload_json").notNull(),
    progressIdempotencyDigest: text("progress_idempotency_digest"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    runIdx: index("run_events_run_idx").on(table.runId),
    routingLatestIdx: index("run_events_routing_latest_idx").on(table.runId, table.type, table.id),
    progressIdempotencyIdx: uniqueIndex("run_events_progress_idempotency_idx").on(
      table.runId,
      table.progressIdempotencyDigest
    )
  })
);

export const sourceDeliveries = sqliteTable(
  "source_deliveries",
  {
    source: text("source").notNull(),
    deliveryId: text("delivery_id").notNull(),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.deliveryId] }),
    runIdx: index("source_deliveries_run_idx").on(table.runId)
  })
);

export const controlPlaneEvents = sqliteTable(
  "control_plane_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    subject: text("subject"),
    idempotencyKey: text("idempotency_key"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    typeIdx: index("control_plane_events_type_idx").on(table.type),
    severityIdx: index("control_plane_events_severity_idx").on(table.severity),
    idempotencyIdx: uniqueIndex("control_plane_events_idempotency_key_idx").on(table.idempotencyKey)
  })
);

export const factoryRecipeSnapshots = sqliteTable(
  "factory_recipe_snapshots",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    recipeJson: text("recipe_json").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.version] }) })
);

export const factoryWorkstreams = sqliteTable(
  "factory_workstreams",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id").notNull(),
    recipeVersion: integer("recipe_version").notNull(),
    workstreamJson: text("workstream_json").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({ recipeIdx: index("factory_workstreams_recipe_idx").on(table.recipeId, table.recipeVersion) })
);

export const factoryWorkstreamMembers = sqliteTable(
  "factory_workstream_members",
  {
    workstreamId: text("workstream_id").notNull(),
    workThreadId: text("work_thread_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workstreamId, table.workThreadId] }),
    threadIdx: index("factory_workstream_members_thread_idx").on(table.workThreadId)
  })
);

export const workstreamAdmissionBatches = sqliteTable(
  "workstream_admission_batches",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestJson: text("request_json").notNull(),
    status: text("status").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => ({ workstreamStatusIdx: index("workstream_admission_batches_workstream_status_idx").on(table.workstreamId, table.status) })
);

export const workstreamAdmissionBatchItems = sqliteTable(
  "workstream_admission_batch_items",
  {
    batchId: text("batch_id").notNull(),
    itemId: text("item_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    runId: text("run_id").notNull(),
    workThreadId: text("work_thread_id").notNull(),
    eventJson: text("event_json").notNull(),
    status: text("status").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.batchId, table.itemId] }),
    ordinalIdx: uniqueIndex("workstream_admission_batch_items_ordinal_idx").on(table.batchId, table.ordinal),
    statusIdx: index("workstream_admission_batch_items_status_idx").on(table.batchId, table.status)
  })
);

export const suggestedChanges = sqliteTable("suggested_changes", {
  proposalId: text("proposal_id").primaryKey(),
  runId: text("run_id").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const approvalDecisions = sqliteTable("approval_decisions", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  decisionJson: text("decision_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    capability: text("capability").notNull(),
    resourceScopeJson: text("resource_scope_json").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id"),
    expiresAt: text("expires_at"),
    constraintsJson: text("constraints_json"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({ runIdx: index("grants_run_idx").on(table.runId), attemptIdx: index("grants_attempt_idx").on(table.attemptId) })
);

export const materialActions = sqliteTable(
  "material_actions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    actionFamily: text("action_family").notNull(),
    capability: text("capability").notNull(),
    scopeJson: text("scope_json").notNull(),
    targetJson: text("target_json").notNull(),
    riskTier: text("risk_tier").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    proposalId: text("proposal_id"),
    proposalHash: text("proposal_hash"),
    decisionSnapshotHash: text("decision_snapshot_hash"),
    attemptFenceDigest: text("attempt_fence_digest").notNull(),
    receiptJson: text("receipt_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    idempotencyIdx: index("material_actions_idempotency_idx").on(table.idempotencyKey),
    runIdx: index("material_actions_run_idx").on(table.runId),
    proposalIdx: index("material_actions_proposal_idx").on(table.proposalId)
  })
);

export const applyPlans = sqliteTable("apply_plans", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  approvalDecisionId: text("approval_decision_id").notNull(),
  planJson: text("plan_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const runners = sqliteTable("runners", {
  runnerId: text("runner_id").primaryKey(),
  name: text("name").notNull(),
  locality: text("locality").notNull().default("local"),
  declaredState: text("declared_state").notNull().default("ready"),
  executorsJson: text("executors_json").notNull().default("[]"),
  maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(1000),
  preference: integer("preference").notNull().default(0),
  claimCursorCreatedAt: text("claim_cursor_created_at"),
  claimCursorRunId: text("claim_cursor_run_id"),
  createdAt: text("created_at").notNull(),
  heartbeatAt: text("heartbeat_at")
});

export const repoBindings = sqliteTable(
  "repo_bindings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    runnerId: text("runner_id").notNull(),
    fallbackRunnerIdsJson: text("fallback_runner_ids_json"),
    workspacePath: text("workspace_path"),
    defaultExecutor: text("default_executor"),
    fallbackExecutorIdsJson: text("fallback_executor_ids_json"),
    allowedActorsJson: text("allowed_actors_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    repoUniqueIdx: uniqueIndex("repo_bindings_provider_owner_repo_idx").on(table.provider, table.owner, table.repo)
  })
);

export const repoPolicyRules = sqliteTable(
  "repo_policy_rules",
  {
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    ruleJson: text("rule_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.owner, table.repo, table.id] })
  })
);

export const repoMutationMappings = sqliteTable(
  "repo_mutation_mappings",
  {
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    mappingJson: text("mapping_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.owner, table.repo, table.id] })
  })
);

export const linearRelayInstallations = sqliteTable(
  "linear_relay_installations",
  {
    id: text("id").primaryKey(),
    webhookPath: text("webhook_path").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    token: text("token").notNull(),
    authJson: text("auth_json"),
    graphqlUrl: text("graphql_url"),
    repoProvider: text("repo_provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    organizationId: text("organization_id"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    webhookPathUniqueIdx: uniqueIndex("linear_relay_installations_webhook_path_idx").on(table.webhookPath),
    organizationUniqueIdx: uniqueIndex("linear_relay_installations_organization_idx").on(table.organizationId)
  })
);

export const linearOAuthInstallStates = sqliteTable("linear_oauth_install_states", {
  state: text("state").primaryKey(),
  installationId: text("installation_id").notNull(),
  webhookPath: text("webhook_path").notNull(),
  webhookSecret: text("webhook_secret").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  graphqlUrl: text("graphql_url"),
  repoProvider: text("repo_provider").notNull(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  teamId: text("team_id"),
  teamKey: text("team_key"),
  scopesJson: text("scopes_json").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  completedAt: text("completed_at")
});

export const channelBindings = sqliteTable(
  "channel_bindings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    accountId: text("account_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    repoProvider: text("repo_provider"),
    owner: text("owner"),
    repo: text("repo"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    channelBindingUniqueIdx: uniqueIndex("channel_bindings_provider_account_conversation_idx").on(
      table.provider,
      table.accountId,
      table.conversationId
    )
  })
);

export const workThreads = sqliteTable(
  "work_threads",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    provider: text("provider").notNull(),
    ownerContainerId: text("owner_container_id").notNull(),
    workItemKind: text("work_item_kind").notNull(),
    externalId: text("external_id").notNull(),
    threadJson: text("thread_json").notNull(),
    currentAssessmentId: text("current_assessment_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    canonicalKeyIdx: uniqueIndex("work_threads_scope_canonical_key_idx").on(table.scopeId, table.canonicalKey),
    currentAssessmentIdx: index("work_threads_current_assessment_idx").on(table.currentAssessmentId)
  })
);

export const completionContracts = sqliteTable(
  "completion_contracts",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    workThreadId: text("work_thread_id").notNull(),
    cycle: integer("cycle").notNull(),
    contractJson: text("contract_json").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.version] }),
    threadCycleIdx: index("completion_contracts_thread_cycle_idx").on(table.workThreadId, table.cycle, table.version)
  })
);

export const verificationEvidenceRecords = sqliteTable(
  "verification_evidence",
  {
    id: text("id").primaryKey(),
    workThreadId: text("work_thread_id"),
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    subjectVersion: text("subject_version").notNull(),
    kind: text("kind").notNull(),
    assurance: text("assurance").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    observedAt: text("observed_at").notNull(),
    receivedAt: text("received_at").notNull()
  },
  (table) => ({
    deliverySubjectIdx: uniqueIndex("verification_evidence_delivery_subject_idx").on(
      table.provider,
      table.deliveryId,
      table.subjectRef,
      table.subjectVersion,
      table.kind
    ),
    threadIdx: index("verification_evidence_thread_idx").on(table.workThreadId, table.receivedAt)
  })
);

export const completionAssessments = sqliteTable(
  "completion_assessments",
  {
    id: text("id").primaryKey(),
    workThreadId: text("work_thread_id").notNull(),
    contractId: text("contract_id").notNull(),
    contractVersion: integer("contract_version").notNull(),
    cycle: integer("cycle").notNull(),
    sequence: integer("sequence").notNull(),
    supersedesAssessmentId: text("supersedes_assessment_id"),
    inputDigest: text("input_digest").notNull(),
    state: text("state").notNull(),
    assessmentJson: text("assessment_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    threadSequenceIdx: uniqueIndex("completion_assessments_thread_cycle_sequence_idx").on(
      table.workThreadId,
      table.cycle,
      table.sequence
    ),
    supersedesIdx: uniqueIndex("completion_assessments_supersedes_idx").on(table.supersedesAssessmentId),
    inputDigestIdx: uniqueIndex("completion_assessments_thread_cycle_input_idx").on(
      table.workThreadId,
      table.cycle,
      table.inputDigest
    )
  })
);

export const completionWaivers = sqliteTable(
  "completion_waivers",
  {
    id: text("id").primaryKey(),
    workThreadId: text("work_thread_id").notNull(),
    contractId: text("contract_id").notNull(),
    contractVersion: integer("contract_version").notNull(),
    cycle: integer("cycle").notNull(),
    contentDigest: text("content_digest").notNull(),
    waiverJson: text("waiver_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    contentIdx: uniqueIndex("completion_waivers_thread_cycle_content_idx").on(
      table.workThreadId,
      table.cycle,
      table.contentDigest
    ),
    threadIdx: index("completion_waivers_thread_idx").on(table.workThreadId, table.createdAt)
  })
);

export const humanEscalations = sqliteTable(
  "human_escalations",
  {
    id: text("id").primaryKey(),
    workThreadId: text("work_thread_id").notNull(),
    class: text("class").notNull(),
    state: text("state").notNull(),
    dedupeKey: text("dedupe_key"),
    activeDedupeKey: text("active_dedupe_key"),
    escalationJson: text("escalation_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    activeDedupeIdx: uniqueIndex("human_escalations_active_dedupe_idx").on(table.workThreadId, table.activeDedupeKey),
    threadIdx: index("human_escalations_thread_idx").on(table.workThreadId, table.createdAt)
  })
);

export const governanceEvents = sqliteTable(
  "governance_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workThreadId: text("work_thread_id"),
    type: text("type").notNull(),
    subjectId: text("subject_id"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    threadIdx: index("governance_events_thread_idx").on(table.workThreadId, table.id),
    typeIdx: index("governance_events_type_idx").on(table.type)
  })
);

export const reassessmentObligations = sqliteTable(
  "reassessment_obligations",
  {
    id: text("id").primaryKey(),
    workThreadId: text("work_thread_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    notBefore: text("not_before").notNull(),
    state: text("state").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    leaseToken: text("lease_token"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastReasonCode: text("last_reason_code"),
    lastError: text("last_error"),
    satisfiedAssessmentId: text("satisfied_assessment_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    sourceIdentityIdx: uniqueIndex("reassessment_obligations_source_identity_idx").on(
      table.sourceKind,
      table.sourceId,
      table.sourceDigest
    ),
    dueIdx: index("reassessment_obligations_due_idx").on(
      table.state,
      table.notBefore,
      table.leaseExpiresAt,
      table.createdAt,
      table.id
    ),
    threadStateIdx: index("reassessment_obligations_thread_state_idx").on(
      table.workThreadId,
      table.state,
      table.createdAt
    )
  })
);

export const controlPlaneProjectionOutbox = sqliteTable(
  "control_plane_projection_outbox",
  {
    receiptId: text("receipt_id").notNull(),
    destinationId: text("destination_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id"),
    runId: text("run_id"),
    workThreadId: text("work_thread_id"),
    receiptKind: text("receipt_kind").notNull(),
    identityNamespace: text("identity_namespace").notNull(),
    identityPartsJson: text("identity_parts_json").notNull(),
    identityKey: text("identity_key").notNull(),
    operationId: text("operation_id").notNull(),
    dependsOnReceiptId: text("depends_on_receipt_id"),
    requiresLifecycleOperationId: text("requires_lifecycle_operation_id"),
    payloadDigest: text("payload_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    lastReasonCode: text("last_reason_code"),
    lastHttpStatus: integer("last_http_status"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
  },
  (table) => ({
    pk: primaryKey({
      name: "control_plane_projection_outbox_pk",
      columns: [table.destinationId, table.organizationId, table.receiptId]
    }),
    destinationIdentityIdx: uniqueIndex("control_plane_projection_outbox_destination_identity_idx").on(
      table.destinationId,
      table.organizationId,
      table.identityKey
    ),
    destinationOperationIdx: uniqueIndex("control_plane_projection_outbox_destination_operation_idx").on(
      table.destinationId,
      table.organizationId,
      table.operationId
    ),
    dueIdx: index("control_plane_projection_outbox_due_idx").on(
      table.destinationId,
      table.state,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.createdAt,
      table.receiptId
    ),
    tenantIdx: index("control_plane_projection_outbox_tenant_idx").on(
      table.destinationId,
      table.organizationId,
      table.state,
      table.createdAt
    ),
    attemptCountCheck: check(
      "control_plane_projection_outbox_attempt_count_check",
      sql`typeof(${table.attemptCount}) = 'integer' AND ${table.attemptCount} >= 0`
    ),
    httpStatusCheck: check(
      "control_plane_projection_outbox_http_status_check",
      sql`${table.lastHttpStatus} IS NULL OR (typeof(${table.lastHttpStatus}) = 'integer' AND ${table.lastHttpStatus} >= 100 AND ${table.lastHttpStatus} <= 599)`
    ),
    receiptKindCheck: check(
      "control_plane_projection_outbox_receipt_kind_check",
      sql`${table.receiptKind} IN ('runner_readiness', 'work_thread_ref', 'completion_contract_ref', 'completion_evidence_observation', 'completion_assessment', 'callback_intent_observation', 'callback_attempt_observation', 'callback_provider_observation')`
    ),
    jsonShapeCheck: check(
      "control_plane_projection_outbox_json_shape_check",
      sql`json_valid(${table.identityPartsJson}) AND json_type(${table.identityPartsJson}) = 'array' AND json_valid(${table.envelopeJson}) AND json_type(${table.envelopeJson}) = 'object'`
    ),
    digestShapeCheck: check(
      "control_plane_projection_outbox_digest_shape_check",
      sql`length(${table.payloadDigest}) = 71 AND substr(${table.payloadDigest}, 1, 7) = 'sha256:' AND substr(${table.payloadDigest}, 8) NOT GLOB '*[^0-9a-f]*' AND length(${table.receiptDigest}) = 71 AND substr(${table.receiptDigest}, 1, 7) = 'sha256:' AND substr(${table.receiptDigest}, 8) NOT GLOB '*[^0-9a-f]*'`
    ),
    stateShapeCheck: check(
      "control_plane_projection_outbox_state_shape_check",
      sql`(
        (${table.state} = 'pending' AND ${table.nextAttemptAt} IS NOT NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.acknowledgedAt} IS NULL)
        OR (${table.state} = 'leased' AND ${table.nextAttemptAt} IS NOT NULL AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.acknowledgedAt} IS NULL)
        OR (${table.state} = 'acknowledged' AND ${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.acknowledgedAt} IS NOT NULL)
        OR (${table.state} = 'attention' AND ${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.acknowledgedAt} IS NULL AND ${table.lastReasonCode} IS NOT NULL)
      )`
    )
  })
);

function migrateCompletionGovernanceSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS opentag_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const migrationId = "2026-07-21-completion-governance-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS work_threads (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        owner_container_id TEXT NOT NULL,
        work_item_kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        thread_json TEXT NOT NULL,
        current_assessment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS work_threads_scope_canonical_key_idx
        ON work_threads(scope_id, canonical_key);
      CREATE INDEX IF NOT EXISTS work_threads_current_assessment_idx
        ON work_threads(current_assessment_id);

      CREATE TABLE IF NOT EXISTS completion_contracts (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        work_thread_id TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE INDEX IF NOT EXISTS completion_contracts_thread_cycle_idx
        ON completion_contracts(work_thread_id, cycle, version);

      CREATE TABLE IF NOT EXISTS verification_evidence (
        id TEXT PRIMARY KEY,
        work_thread_id TEXT,
        provider TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        subject_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        assurance TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS verification_evidence_delivery_subject_idx
        ON verification_evidence(provider, delivery_id, subject_ref, subject_version, kind);
      CREATE INDEX IF NOT EXISTS verification_evidence_thread_idx
        ON verification_evidence(work_thread_id, received_at);

      CREATE TABLE IF NOT EXISTS completion_assessments (
        id TEXT PRIMARY KEY,
        work_thread_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        cycle INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        supersedes_assessment_id TEXT,
        input_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        assessment_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS completion_assessments_thread_cycle_sequence_idx
        ON completion_assessments(work_thread_id, cycle, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS completion_assessments_supersedes_idx
        ON completion_assessments(supersedes_assessment_id);
      CREATE UNIQUE INDEX IF NOT EXISTS completion_assessments_thread_cycle_input_idx
        ON completion_assessments(work_thread_id, cycle, input_digest);

      CREATE TABLE IF NOT EXISTS human_escalations (
        id TEXT PRIMARY KEY,
        work_thread_id TEXT NOT NULL,
        class TEXT NOT NULL,
        state TEXT NOT NULL,
        dedupe_key TEXT,
        active_dedupe_key TEXT,
        escalation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS human_escalations_active_dedupe_idx
        ON human_escalations(work_thread_id, active_dedupe_key);
      CREATE INDEX IF NOT EXISTS human_escalations_thread_idx
        ON human_escalations(work_thread_id, created_at);

      CREATE TABLE IF NOT EXISTS governance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_thread_id TEXT,
        type TEXT NOT NULL,
        subject_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS governance_events_thread_idx
        ON governance_events(work_thread_id, id);
      CREATE INDEX IF NOT EXISTS governance_events_type_idx
        ON governance_events(type);
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateCompletionWaiverSchema(sqlite: Database.Database): void {
  const migrationId = "2026-07-21-completion-waivers-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS completion_waivers (
        id TEXT PRIMARY KEY,
        work_thread_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        cycle INTEGER NOT NULL,
        content_digest TEXT NOT NULL,
        waiver_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS completion_waivers_thread_cycle_content_idx
        ON completion_waivers(work_thread_id, cycle, content_digest);
      CREATE INDEX IF NOT EXISTS completion_waivers_thread_idx
        ON completion_waivers(work_thread_id, created_at);
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateHumanEscalationAccessIdentitySchema(sqlite: Database.Database): void {
  const migrationId = "2026-07-25-human-escalation-access-identity-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    const columns = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("access_profile_snapshot_json")) {
      sqlite.exec("ALTER TABLE runs ADD COLUMN access_profile_snapshot_json TEXT");
    }
    if (!columnNames.has("policy_snapshot_provenance_json")) {
      sqlite.exec("ALTER TABLE runs ADD COLUMN policy_snapshot_provenance_json TEXT");
    }
    const followUpColumns = sqlite.prepare("PRAGMA table_info(follow_up_requests)").all() as { name: string }[];
    const followUpColumnNames = new Set(followUpColumns.map((column) => column.name));
    if (!followUpColumnNames.has("access_profile_snapshot_json")) {
      sqlite.exec("ALTER TABLE follow_up_requests ADD COLUMN access_profile_snapshot_json TEXT");
    }
    if (!followUpColumnNames.has("policy_snapshot_provenance_json")) {
      sqlite.exec("ALTER TABLE follow_up_requests ADD COLUMN policy_snapshot_provenance_json TEXT");
    }
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateFactoryWorkstreamSchema(sqlite: Database.Database): void {
  const migrationId = "2026-07-26-factory-workstreams-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    const runColumns = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    const runColumnNames = new Set(runColumns.map((column) => column.name));
    if (!runColumnNames.has("workstream_id")) sqlite.exec("ALTER TABLE runs ADD COLUMN workstream_id TEXT");
    if (!runColumnNames.has("admission_batch_id")) sqlite.exec("ALTER TABLE runs ADD COLUMN admission_batch_id TEXT");
    const attemptColumns = sqlite.prepare("PRAGMA table_info(attempts)").all() as { name: string }[];
    if (!attemptColumns.some((column) => column.name === "runner_locality")) {
      sqlite.exec("ALTER TABLE attempts ADD COLUMN runner_locality TEXT");
    }
    const followUpColumns = sqlite.prepare("PRAGMA table_info(follow_up_requests)").all() as { name: string }[];
    const followUpColumnNames = new Set(followUpColumns.map((column) => column.name));
    if (!followUpColumnNames.has("workstream_id")) sqlite.exec("ALTER TABLE follow_up_requests ADD COLUMN workstream_id TEXT");
    if (!followUpColumnNames.has("admission_batch_id")) sqlite.exec("ALTER TABLE follow_up_requests ADD COLUMN admission_batch_id TEXT");
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS runs_workstream_idx ON runs(workstream_id, status);
      CREATE INDEX IF NOT EXISTS runs_admission_batch_idx ON runs(admission_batch_id);

      CREATE TABLE IF NOT EXISTS factory_recipe_snapshots (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        recipe_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS factory_workstreams (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL,
        recipe_version INTEGER NOT NULL,
        workstream_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS factory_workstreams_recipe_idx
        ON factory_workstreams(recipe_id, recipe_version);
      CREATE TABLE IF NOT EXISTS factory_workstream_members (
        workstream_id TEXT NOT NULL,
        work_thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workstream_id, work_thread_id)
      );
      CREATE INDEX IF NOT EXISTS factory_workstream_members_thread_idx
        ON factory_workstream_members(work_thread_id);
      CREATE TABLE IF NOT EXISTS workstream_admission_batches (
        id TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workstream_admission_batches_workstream_status_idx
        ON workstream_admission_batches(workstream_id, status);
      CREATE TABLE IF NOT EXISTS workstream_admission_batch_items (
        batch_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        work_thread_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (batch_id, item_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workstream_admission_batch_items_ordinal_idx
        ON workstream_admission_batch_items(batch_id, ordinal);
      CREATE INDEX IF NOT EXISTS workstream_admission_batch_items_status_idx
        ON workstream_admission_batch_items(batch_id, status);
    `);
    const controlPlaneColumns = sqlite.prepare("PRAGMA table_info(control_plane_events)").all() as { name: string }[];
    if (!controlPlaneColumns.some((column) => column.name === "idempotency_key")) {
      sqlite.exec("ALTER TABLE control_plane_events ADD COLUMN idempotency_key TEXT");
    }
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS control_plane_events_idempotency_key_idx ON control_plane_events(idempotency_key)");
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(migrationId, new Date().toISOString());
  })();
}

function migrateReassessmentObligationSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-04-reassessment-obligations-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reassessment_obligations (
        id TEXT PRIMARY KEY,
        work_thread_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        not_before TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        lease_token TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_reason_code TEXT,
        last_error TEXT,
        satisfied_assessment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reassessment_obligations_source_identity_idx
        ON reassessment_obligations(source_kind, source_id, source_digest);
      CREATE INDEX IF NOT EXISTS reassessment_obligations_due_idx
        ON reassessment_obligations(state, not_before, lease_expires_at, created_at, id);
      CREATE INDEX IF NOT EXISTS reassessment_obligations_thread_state_idx
        ON reassessment_obligations(work_thread_id, state, created_at);
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateControlPlaneProjectionOutboxSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-08-control-plane-projection-outbox-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS control_plane_projection_outbox (
        receipt_id TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT,
        run_id TEXT,
        work_thread_id TEXT,
        receipt_kind TEXT NOT NULL,
        identity_namespace TEXT NOT NULL,
        identity_parts_json TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_reason_code TEXT,
        last_http_status INTEGER CHECK (last_http_status IS NULL OR (typeof(last_http_status) = 'integer' AND last_http_status >= 100 AND last_http_status <= 599)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        CONSTRAINT control_plane_projection_outbox_pk PRIMARY KEY (destination_id, organization_id, receipt_id),
        CONSTRAINT control_plane_projection_outbox_receipt_kind_check CHECK (
          receipt_kind IN (
            'runner_readiness', 'work_thread_ref', 'completion_contract_ref',
            'completion_evidence_observation', 'completion_assessment', 'callback_intent_observation',
            'callback_attempt_observation', 'callback_provider_observation'
          )
        ),
        CONSTRAINT control_plane_projection_outbox_json_shape_check CHECK (
          json_valid(identity_parts_json) AND json_type(identity_parts_json) = 'array'
          AND json_valid(envelope_json) AND json_type(envelope_json) = 'object'
        ),
        CONSTRAINT control_plane_projection_outbox_digest_shape_check CHECK (
          length(payload_digest) = 71 AND substr(payload_digest, 1, 7) = 'sha256:'
          AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
          AND length(receipt_digest) = 71 AND substr(receipt_digest, 1, 7) = 'sha256:'
          AND substr(receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        CONSTRAINT control_plane_projection_outbox_state_shape_check CHECK (
          (state = 'pending' AND next_attempt_at IS NOT NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_at IS NULL)
          OR (state = 'leased' AND next_attempt_at IS NOT NULL AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND acknowledged_at IS NULL)
          OR (state = 'acknowledged' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_at IS NOT NULL)
          OR (state = 'attention' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_at IS NULL AND last_reason_code IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS control_plane_projection_outbox_destination_identity_idx
        ON control_plane_projection_outbox(destination_id, organization_id, identity_key);
      CREATE UNIQUE INDEX IF NOT EXISTS control_plane_projection_outbox_destination_operation_idx
        ON control_plane_projection_outbox(destination_id, organization_id, operation_id);
      CREATE INDEX IF NOT EXISTS control_plane_projection_outbox_due_idx
        ON control_plane_projection_outbox(destination_id, state, next_attempt_at, lease_expires_at, created_at, receipt_id);
      CREATE INDEX IF NOT EXISTS control_plane_projection_outbox_tenant_idx
        ON control_plane_projection_outbox(destination_id, organization_id, state, created_at);
      CREATE TRIGGER IF NOT EXISTS control_plane_projection_outbox_duplicate_insert_guard
      BEFORE INSERT ON control_plane_projection_outbox
      WHEN EXISTS (
        SELECT 1 FROM control_plane_projection_outbox existing
        WHERE (
            existing.destination_id = NEW.destination_id
            AND existing.organization_id = NEW.organization_id
            AND existing.receipt_id = NEW.receipt_id
          )
          OR (
            existing.destination_id = NEW.destination_id
            AND existing.organization_id = NEW.organization_id
            AND existing.identity_key = NEW.identity_key
          )
          OR (
            existing.destination_id = NEW.destination_id
            AND existing.organization_id = NEW.organization_id
            AND existing.operation_id = NEW.operation_id
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_duplicate_insert');
      END;
      CREATE TRIGGER IF NOT EXISTS control_plane_projection_outbox_insert_guard
      BEFORE INSERT ON control_plane_projection_outbox
      WHEN (
        NEW.state = 'pending'
        AND NEW.attempt_count = 0
        AND NEW.next_attempt_at IS NOT NULL
        AND NEW.lease_owner IS NULL
        AND NEW.lease_token IS NULL
        AND NEW.lease_expires_at IS NULL
        AND NEW.last_reason_code IS NULL
        AND NEW.last_http_status IS NULL
        AND NEW.acknowledged_at IS NULL
        AND NEW.created_at = NEW.updated_at
        AND length(NEW.created_at) = 24
        AND NEW.created_at GLOB '????-??-??T??:??:??.???Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) = NEW.created_at
        AND length(NEW.next_attempt_at) = 24
        AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.next_attempt_at) = NEW.next_attempt_at
        AND NEW.next_attempt_at >= NEW.created_at
        AND json_extract(NEW.envelope_json, '$.receiptId') = NEW.receipt_id
        AND json_extract(NEW.envelope_json, '$.organizationId') = NEW.organization_id
        AND json_extract(NEW.envelope_json, '$.receiptKind') = NEW.receipt_kind
        AND json_extract(NEW.envelope_json, '$.identity.namespace') = NEW.identity_namespace
        AND json_extract(NEW.envelope_json, '$.identity.parts') = json(NEW.identity_parts_json)
        AND json_extract(NEW.envelope_json, '$.operationId') = NEW.operation_id
        AND json_extract(NEW.envelope_json, '$.payloadDigest') = NEW.payload_digest
        AND json_extract(NEW.envelope_json, '$.receiptDigest') = NEW.receipt_digest
        AND json_extract(NEW.envelope_json, '$.runId') IS NEW.run_id
        AND json_extract(NEW.envelope_json, '$.workThreadId') IS NEW.work_thread_id
        AND (
          (NEW.receipt_kind = 'runner_readiness'
            AND json_extract(NEW.envelope_json, '$.payload.runnerId') = NEW.runner_id)
          OR (NEW.receipt_kind <> 'runner_readiness' AND NEW.runner_id IS NULL)
        )
      ) IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1 FROM control_plane_projection_outbox existing
        WHERE existing.destination_id = NEW.destination_id
          AND existing.organization_id = NEW.organization_id
          AND (
            existing.receipt_id = NEW.receipt_id
            OR existing.identity_key = NEW.identity_key
            OR existing.operation_id = NEW.operation_id
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_insert_invalid');
      END;
      CREATE TRIGGER IF NOT EXISTS control_plane_projection_outbox_immutable_update_guard
      BEFORE UPDATE OF
        receipt_id, destination_id, organization_id, runner_id, run_id, work_thread_id,
        receipt_kind, identity_namespace, identity_parts_json, identity_key, operation_id,
        payload_digest, receipt_digest, envelope_json, created_at
      ON control_plane_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS control_plane_projection_outbox_transition_guard
      BEFORE UPDATE OF
        state, attempt_count, next_attempt_at, lease_owner, lease_token,
        lease_expires_at, last_reason_code, last_http_status, updated_at,
      acknowledged_at
      ON control_plane_projection_outbox
      WHEN (
        length(NEW.updated_at) = 24
        AND NEW.updated_at GLOB '????-??-??T??:??:??.???Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at
        AND NEW.updated_at >= OLD.updated_at
        AND (NEW.last_http_status IS NULL OR (typeof(NEW.last_http_status) = 'integer' AND NEW.last_http_status >= 100 AND NEW.last_http_status <= 599))
        AND (
          NEW.last_reason_code IS NULL
          OR (
            length(NEW.last_reason_code) > 0
            AND NEW.last_reason_code NOT GLOB '*[^A-Za-z0-9._:@/#-]*'
            AND instr(lower(NEW.last_reason_code), '://') = 0
            AND NEW.last_reason_code NOT LIKE '../%'
            AND NEW.last_reason_code NOT LIKE '%/../%'
            AND NEW.last_reason_code NOT LIKE '%/..'
          )
        )
        AND (
          NEW.lease_owner IS NULL
          OR (
            length(NEW.lease_owner) > 0
            AND NEW.lease_owner NOT GLOB '*[^A-Za-z0-9._:@/#-]*'
            AND instr(lower(NEW.lease_owner), '://') = 0
            AND NEW.lease_owner NOT LIKE '../%'
            AND NEW.lease_owner NOT LIKE '%/../%'
            AND NEW.lease_owner NOT LIKE '%/..'
          )
        )
        AND (
          (
            OLD.state = 'pending' AND NEW.state = 'leased'
            AND NEW.attempt_count = OLD.attempt_count + 1
            AND NEW.next_attempt_at IS OLD.next_attempt_at
            AND length(NEW.next_attempt_at) = 24
            AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.next_attempt_at) = NEW.next_attempt_at
            AND NEW.lease_owner IS NOT NULL
            AND NEW.lease_token IS NOT NULL
            AND NEW.lease_expires_at IS NOT NULL
            AND length(NEW.lease_expires_at) = 24
            AND NEW.lease_expires_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at) = NEW.lease_expires_at
            AND NEW.lease_expires_at > NEW.updated_at
            AND NEW.last_reason_code IS OLD.last_reason_code
            AND NEW.last_http_status IS OLD.last_http_status
            AND NEW.acknowledged_at IS NULL
          )
          OR (
            OLD.state = 'leased' AND NEW.state = 'pending'
            AND NEW.attempt_count = OLD.attempt_count
            AND NEW.next_attempt_at IS NOT NULL
            AND length(NEW.next_attempt_at) = 24
            AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.next_attempt_at) = NEW.next_attempt_at
            AND NEW.next_attempt_at >= NEW.updated_at
            AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
            AND NEW.last_reason_code IS NOT NULL
            AND NEW.acknowledged_at IS NULL
          )
          OR (
            OLD.state = 'leased' AND NEW.state = 'acknowledged'
            AND NEW.attempt_count = OLD.attempt_count
            AND NEW.next_attempt_at IS NULL
            AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
            AND NEW.last_reason_code IS OLD.last_reason_code
            AND NEW.acknowledged_at = NEW.updated_at
          )
          OR (
            OLD.state = 'leased' AND NEW.state = 'attention'
            AND NEW.attempt_count = OLD.attempt_count
            AND NEW.next_attempt_at IS NULL
            AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
            AND NEW.last_reason_code IS NOT NULL
            AND NEW.acknowledged_at IS NULL
          )
        )
      ) IS NOT TRUE
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_transition_invalid');
      END;
      CREATE TRIGGER IF NOT EXISTS control_plane_projection_outbox_delete_guard
      BEFORE DELETE ON control_plane_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_delete_forbidden');
      END;
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateHostedRunImportSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-hosted-run-import-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hosted_run_imports (
        run_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL,
        admission_operation_id TEXT NOT NULL,
        claim_operation_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        fencing_token_digest TEXT NOT NULL,
        source_identity_digest TEXT NOT NULL,
        delivery_payload_digest TEXT NOT NULL,
        admission_envelope_digest TEXT NOT NULL,
        policy_receipt_id TEXT NOT NULL,
        policy_payload_digest TEXT NOT NULL,
        policy_receipt_digest TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        context_packet_digest TEXT NOT NULL,
        work_thread_id TEXT,
        work_thread_digest TEXT,
        claim_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_run_imports_admission_idx
        ON hosted_run_imports(admission_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_run_imports_claim_operation_idx
        ON hosted_run_imports(claim_operation_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_run_imports_attempt_idx
        ON hosted_run_imports(attempt_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_run_imports_fence_idx
        ON hosted_run_imports(fencing_token_digest);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_run_imports_source_idx
        ON hosted_run_imports(source_identity_digest);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_run_imports_authority_idx
        ON hosted_run_imports(authority_digest);
      CREATE INDEX IF NOT EXISTS hosted_run_imports_work_thread_idx
        ON hosted_run_imports(work_thread_id);
      CREATE TRIGGER IF NOT EXISTS hosted_run_imports_immutable_update_guard
      BEFORE UPDATE ON hosted_run_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_run_imports_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS hosted_run_imports_delete_guard
      BEFORE DELETE ON hosted_run_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_run_imports_delete_forbidden');
      END;
      CREATE TABLE IF NOT EXISTS hosted_claim_operations (
        operation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        active_key TEXT,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'empty')),
        run_id TEXT,
        terminal_reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_claim_operations_request_idx
        ON hosted_claim_operations(request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_claim_operations_active_idx
        ON hosted_claim_operations(active_key);
      CREATE INDEX IF NOT EXISTS hosted_claim_operations_runner_state_idx
        ON hosted_claim_operations(destination_id, organization_id, runner_id, state);
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateHostedExecutionStartSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-hosted-execution-start-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    const columns = sqlite.prepare("PRAGMA table_info(hosted_claim_operations)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "execution_started_at")) {
      sqlite.exec("ALTER TABLE hosted_claim_operations ADD COLUMN execution_started_at TEXT");
    }
    if (!columns.some((column) => column.name === "terminal_reason_code")) {
      sqlite.exec("ALTER TABLE hosted_claim_operations ADD COLUMN terminal_reason_code TEXT");
    }
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateHostedClaimAuthorityShellSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-hosted-claim-authority-shell-v1";
  if (sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId)) return;
  sqlite.transaction(() => {
    const columns = sqlite.prepare("PRAGMA table_info(hosted_claim_operations)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    const additions = [
      ["claim_digest", "TEXT"], ["authority_digest", "TEXT"], ["authority_json", "TEXT"],
      ["attempt_id", "TEXT"], ["attempt_number", "INTEGER"], ["fencing_token_digest", "TEXT"],
      ["credential_id", "TEXT"], ["lease_expires_at", "TEXT"], ["executor_id", "TEXT"]
    ] as const;
    for (const [name, type] of additions) {
      if (!names.has(name)) sqlite.exec(`ALTER TABLE hosted_claim_operations ADD COLUMN ${name} ${type}`);
    }
    sqlite.exec(`
      DROP TRIGGER IF EXISTS hosted_claim_authority_shell_immutable_guard;
      CREATE TRIGGER hosted_claim_authority_shell_immutable_guard
      BEFORE UPDATE OF claim_digest, authority_digest, authority_json, attempt_id,
        attempt_number, fencing_token_digest, credential_id, lease_expires_at, executor_id
      ON hosted_claim_operations
      WHEN OLD.claim_digest IS NOT NULL AND (
        NEW.claim_digest IS NOT OLD.claim_digest
        OR NEW.authority_digest IS NOT OLD.authority_digest
        OR NEW.authority_json IS NOT OLD.authority_json
        OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.attempt_number IS NOT OLD.attempt_number
        OR NEW.fencing_token_digest IS NOT OLD.fencing_token_digest
        OR NEW.credential_id IS NOT OLD.credential_id
        OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
        OR NEW.executor_id IS NOT OLD.executor_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'hosted_claim_authority_shell_immutable');
      END;
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)")
      .run(migrationId, new Date().toISOString());
  })();
}

function migrateHostedAttemptImportSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-hosted-attempt-import-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hosted_attempt_imports (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        claim_operation_id TEXT NOT NULL,
        fencing_token_digest TEXT NOT NULL,
        claim_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_attempt_imports_run_number_idx
        ON hosted_attempt_imports(run_id, attempt_number);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_attempt_imports_operation_idx
        ON hosted_attempt_imports(claim_operation_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_attempt_imports_fence_idx
        ON hosted_attempt_imports(fencing_token_digest);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_attempt_imports_authority_idx
        ON hosted_attempt_imports(authority_digest);
      CREATE INDEX IF NOT EXISTS hosted_attempt_imports_run_idx
        ON hosted_attempt_imports(run_id);
      CREATE TRIGGER IF NOT EXISTS hosted_attempt_imports_immutable_update_guard
      BEFORE UPDATE ON hosted_attempt_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_attempt_imports_immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS hosted_attempt_imports_delete_guard
      BEFORE DELETE ON hosted_attempt_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_attempt_imports_delete_forbidden');
      END;
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateHostedHeartbeatOperationSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-hosted-heartbeat-operation-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hosted_heartbeat_operations (
        destination_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        fencing_token_digest TEXT NOT NULL,
        expected_lease_expires_at TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        active_key TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged')),
        receipt_digest TEXT,
        receipt_json TEXT,
        accepted_lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY (destination_id, organization_id, runner_id, credential_id, operation_id),
        CHECK (
          (state = 'pending' AND active_key IS NOT NULL AND receipt_digest IS NULL
            AND receipt_json IS NULL AND accepted_lease_expires_at IS NULL
            AND acknowledged_at IS NULL)
          OR
          (state = 'acknowledged' AND active_key IS NULL AND receipt_digest IS NOT NULL
            AND receipt_json IS NOT NULL AND accepted_lease_expires_at IS NOT NULL
            AND acknowledged_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_heartbeat_operations_request_idx
        ON hosted_heartbeat_operations(destination_id, organization_id, runner_id, credential_id, request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_heartbeat_operations_active_idx
        ON hosted_heartbeat_operations(active_key);
      CREATE INDEX IF NOT EXISTS hosted_heartbeat_operations_attempt_idx
        ON hosted_heartbeat_operations(run_id, attempt_id, state);
      CREATE TRIGGER IF NOT EXISTS hosted_heartbeat_operations_update_guard
      BEFORE UPDATE ON hosted_heartbeat_operations
      WHEN (
        OLD.state <> 'pending' OR NEW.state <> 'acknowledged'
        OR NEW.destination_id <> OLD.destination_id
        OR NEW.organization_id <> OLD.organization_id
        OR NEW.runner_id <> OLD.runner_id
        OR NEW.credential_id <> OLD.credential_id
        OR NEW.operation_id <> OLD.operation_id
        OR NEW.request_id <> OLD.request_id
        OR NEW.run_id <> OLD.run_id
        OR NEW.attempt_id <> OLD.attempt_id
        OR NEW.attempt_number <> OLD.attempt_number
        OR NEW.fencing_token_digest <> OLD.fencing_token_digest
        OR NEW.expected_lease_expires_at <> OLD.expected_lease_expires_at
        OR NEW.request_digest <> OLD.request_digest
        OR NEW.request_json <> OLD.request_json
        OR NEW.created_at <> OLD.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'hosted_heartbeat_operations_transition_invalid');
      END;
      CREATE TRIGGER IF NOT EXISTS hosted_heartbeat_operations_delete_guard
      BEFORE DELETE ON hosted_heartbeat_operations
      BEGIN
        SELECT RAISE(ABORT, 'hosted_heartbeat_operations_delete_forbidden');
      END;
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateHostedLifecycleOperationSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-hosted-lifecycle-operation-v1";
  const recreateGuards = (): void => {
    sqlite.exec(`
      DROP TRIGGER IF EXISTS hosted_lifecycle_operations_immutable_guard;
      DROP TRIGGER IF EXISTS hosted_lifecycle_operations_delete_guard;
      CREATE TRIGGER hosted_lifecycle_operations_immutable_guard
      BEFORE UPDATE OF destination_id, organization_id, runner_id, credential_id, operation_id,
        request_id, action, run_id, attempt_id, attempt_number, fencing_token_digest,
        request_digest, business_key_digest, sequence, request_json, created_at
      ON hosted_lifecycle_operations
      BEGIN
        SELECT RAISE(ABORT, 'hosted_lifecycle_operations_immutable');
      END;
      CREATE TRIGGER hosted_lifecycle_operations_delete_guard
      BEFORE DELETE ON hosted_lifecycle_operations
      BEGIN
        SELECT RAISE(ABORT, 'hosted_lifecycle_operations_delete_forbidden');
      END;
    `);
  };
  const existingTable = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hosted_lifecycle_operations'"
  ).get();
  if (existingTable) {
    const columns = sqlite.prepare("PRAGMA table_info(hosted_lifecycle_operations)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const businessKeyColumn = columns.find((column) => column.name === "business_key_digest");
    const sequenceColumn = columns.find((column) => column.name === "sequence");
    if (!businessKeyColumn || businessKeyColumn.notnull !== 1 || !sequenceColumn || sequenceColumn.notnull !== 1) {
      throw new Error(
        "hosted_lifecycle_operations_incompatible_partial_schema: business_key_digest and sequence must be present and NOT NULL",
      );
    }
  }
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) {
    sqlite.transaction(recreateGuards)();
    return;
  }
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hosted_lifecycle_operations (
        destination_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('heartbeat', 'running', 'reject-start', 'progress', 'complete')),
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        fencing_token_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        business_key_digest TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'acknowledged', 'attention')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        receipt_id TEXT,
        receipt_digest TEXT,
        receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
        last_reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY (destination_id, organization_id, runner_id, credential_id, operation_id),
        CHECK (
          (state = 'pending' AND next_attempt_at IS NOT NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NULL AND receipt_digest IS NULL AND receipt_json IS NULL AND acknowledged_at IS NULL)
          OR (state = 'leased' AND next_attempt_at IS NOT NULL AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_id IS NULL AND receipt_digest IS NULL AND receipt_json IS NULL AND acknowledged_at IS NULL)
          OR (state = 'acknowledged' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND acknowledged_at IS NOT NULL)
          OR (state = 'attention' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NULL AND receipt_digest IS NULL AND receipt_json IS NULL AND last_reason_code IS NOT NULL AND acknowledged_at IS NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_lifecycle_operations_request_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, runner_id, credential_id, request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_lifecycle_operations_business_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, runner_id, credential_id, business_key_digest);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_lifecycle_operations_sequence_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, run_id, attempt_id, sequence);
      CREATE INDEX IF NOT EXISTS hosted_lifecycle_operations_due_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, state, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS hosted_lifecycle_operations_attempt_idx
        ON hosted_lifecycle_operations(run_id, attempt_id, state);
    `);
    recreateGuards();
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateControlPlaneProjectionDependenciesSchema(sqlite: Database.Database): void {
  const migrationId = "2026-08-10-control-plane-projection-dependencies-v1";
  const applied = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get(migrationId);
  if (applied) return;
  sqlite.transaction(() => {
    const columns = sqlite.prepare("PRAGMA table_info(control_plane_projection_outbox)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("depends_on_receipt_id")) {
      sqlite.exec("ALTER TABLE control_plane_projection_outbox ADD COLUMN depends_on_receipt_id TEXT");
    }
    if (!names.has("requires_lifecycle_operation_id")) {
      sqlite.exec("ALTER TABLE control_plane_projection_outbox ADD COLUMN requires_lifecycle_operation_id TEXT");
    }
    sqlite.exec(`
      DROP TRIGGER IF EXISTS control_plane_projection_outbox_immutable_update_guard;
      CREATE TRIGGER control_plane_projection_outbox_immutable_update_guard
      BEFORE UPDATE OF
        receipt_id, destination_id, organization_id, runner_id, run_id, work_thread_id,
        receipt_kind, identity_namespace, identity_parts_json, identity_key, operation_id,
        depends_on_receipt_id, requires_lifecycle_operation_id,
        payload_digest, receipt_digest, envelope_json, created_at
      ON control_plane_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_immutable');
      END;
    `);
    sqlite.prepare("INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migrationId,
      new Date().toISOString()
    );
  })();
}

function migrateControlPlaneProjectionEvidenceKindSchema(
  sqlite: Database.Database
): void {
  const migrationId = "2026-08-10-control-plane-projection-evidence-kind-v1";
  const applied = sqlite.prepare(
    "SELECT id FROM opentag_schema_migrations WHERE id = ?"
  ).get(migrationId);
  if (applied) return;

  sqlite.transaction(() => {
    const table = sqlite.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'control_plane_projection_outbox'
    `).get() as { sql: string } | undefined;
    if (!table) {
      throw new Error("control_plane_projection_outbox_missing");
    }

    if (!table.sql.includes("'completion_evidence_observation'")) {
      const dependentSchema = sqlite.prepare(`
        SELECT type, name, sql
        FROM sqlite_master
        WHERE tbl_name = 'control_plane_projection_outbox'
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
        ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name
      `).all() as Array<{
        type: "index" | "trigger";
        name: string;
        sql: string;
      }>;

      for (const schema of dependentSchema) {
        if (schema.type !== "trigger") continue;
        const quotedName = schema.name.replaceAll('"', '""');
        sqlite.exec(`DROP TRIGGER "${quotedName}"`);
      }

      sqlite.exec(`
        ALTER TABLE control_plane_projection_outbox
          RENAME TO control_plane_projection_outbox_legacy_evidence_kind;

        CREATE TABLE control_plane_projection_outbox (
          receipt_id TEXT NOT NULL,
          destination_id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          runner_id TEXT,
          run_id TEXT,
          work_thread_id TEXT,
          receipt_kind TEXT NOT NULL,
          identity_namespace TEXT NOT NULL,
          identity_parts_json TEXT NOT NULL,
          identity_key TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          depends_on_receipt_id TEXT,
          requires_lifecycle_operation_id TEXT,
          payload_digest TEXT NOT NULL,
          receipt_digest TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          state TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
          next_attempt_at TEXT,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at TEXT,
          last_reason_code TEXT,
          last_http_status INTEGER
            CHECK (last_http_status IS NULL OR (
              typeof(last_http_status) = 'integer'
              AND last_http_status >= 100
              AND last_http_status <= 599
            )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          acknowledged_at TEXT,
          CONSTRAINT control_plane_projection_outbox_pk
            PRIMARY KEY (destination_id, organization_id, receipt_id),
          CONSTRAINT control_plane_projection_outbox_receipt_kind_check CHECK (
            receipt_kind IN (
              'runner_readiness', 'work_thread_ref', 'completion_contract_ref',
              'completion_evidence_observation', 'completion_assessment',
              'callback_intent_observation', 'callback_attempt_observation',
              'callback_provider_observation'
            )
          ),
          CONSTRAINT control_plane_projection_outbox_json_shape_check CHECK (
            json_valid(identity_parts_json)
            AND json_type(identity_parts_json) = 'array'
            AND json_valid(envelope_json)
            AND json_type(envelope_json) = 'object'
          ),
          CONSTRAINT control_plane_projection_outbox_digest_shape_check CHECK (
            length(payload_digest) = 71
            AND substr(payload_digest, 1, 7) = 'sha256:'
            AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
            AND length(receipt_digest) = 71
            AND substr(receipt_digest, 1, 7) = 'sha256:'
            AND substr(receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
          ),
          CONSTRAINT control_plane_projection_outbox_state_shape_check CHECK (
            (state = 'pending' AND next_attempt_at IS NOT NULL
              AND lease_owner IS NULL AND lease_token IS NULL
              AND lease_expires_at IS NULL AND acknowledged_at IS NULL)
            OR (state = 'leased' AND next_attempt_at IS NOT NULL
              AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
              AND lease_expires_at IS NOT NULL AND acknowledged_at IS NULL)
            OR (state = 'acknowledged' AND next_attempt_at IS NULL
              AND lease_owner IS NULL AND lease_token IS NULL
              AND lease_expires_at IS NULL AND acknowledged_at IS NOT NULL)
            OR (state = 'attention' AND next_attempt_at IS NULL
              AND lease_owner IS NULL AND lease_token IS NULL
              AND lease_expires_at IS NULL AND acknowledged_at IS NULL
              AND last_reason_code IS NOT NULL)
          )
        );

        INSERT INTO control_plane_projection_outbox (
          receipt_id, destination_id, organization_id, runner_id, run_id,
          work_thread_id, receipt_kind, identity_namespace,
          identity_parts_json, identity_key, operation_id,
          depends_on_receipt_id, requires_lifecycle_operation_id,
          payload_digest, receipt_digest, envelope_json, state, attempt_count,
          next_attempt_at, lease_owner, lease_token, lease_expires_at,
          last_reason_code, last_http_status, created_at, updated_at,
          acknowledged_at
        )
        SELECT
          receipt_id, destination_id, organization_id, runner_id, run_id,
          work_thread_id, receipt_kind, identity_namespace,
          identity_parts_json, identity_key, operation_id,
          depends_on_receipt_id, requires_lifecycle_operation_id,
          payload_digest, receipt_digest, envelope_json, state, attempt_count,
          next_attempt_at, lease_owner, lease_token, lease_expires_at,
          last_reason_code, last_http_status, created_at, updated_at,
          acknowledged_at
        FROM control_plane_projection_outbox_legacy_evidence_kind;

        DROP TABLE control_plane_projection_outbox_legacy_evidence_kind;
      `);

      for (const schema of dependentSchema) {
        sqlite.exec(schema.sql);
      }
    }

    sqlite.prepare(
      "INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)"
    ).run(migrationId, new Date().toISOString());
  })();
}

export function migrateSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      event_json TEXT NOT NULL,
      context_packet_json TEXT,
      access_profile_snapshot_json TEXT,
      policy_snapshot_provenance_json TEXT,
      result_json TEXT,
      assigned_runner_id TEXT,
      executor TEXT,
      parent_run_id TEXT,
      triggered_by_action_json TEXT,
      source_proposal_id TEXT,
      source_apply_plan_id TEXT,
      repo_provider TEXT,
      repo_owner TEXT,
      repo_name TEXT,
      work_thread_id TEXT,
      conversation_key TEXT,
      leased_at TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      current_attempt_id TEXT,
      current_routing_decision_id TEXT,
      routing_policy_json TEXT,
      routing_runner_ids_json TEXT,
      routing_executor_ids_json TEXT,
      routing_rejections_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
    CREATE INDEX IF NOT EXISTS runs_claim_queue_idx ON runs(status, created_at, id);
    CREATE INDEX IF NOT EXISTS runs_lease_recovery_idx ON runs(status, lease_expires_at, created_at, id);
    CREATE INDEX IF NOT EXISTS runs_runner_idx ON runs(assigned_runner_id);
    CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_key);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      runner_id TEXT NOT NULL,
      selected_executor_id TEXT,
      routing_decision_id TEXT,
      fencing_token TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS attempts_run_number_idx ON attempts(run_id, number);
    CREATE INDEX IF NOT EXISTS attempts_run_idx ON attempts(run_id);
    CREATE INDEX IF NOT EXISTS attempts_runner_idx ON attempts(runner_id);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'audit',
      importance TEXT NOT NULL DEFAULT 'normal',
      message TEXT,
      payload_json TEXT NOT NULL,
      progress_idempotency_digest TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS run_events_routing_latest_idx ON run_events(run_id, type, id);
    CREATE TABLE IF NOT EXISTS source_deliveries (
      source TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source, delivery_id)
    );
    CREATE INDEX IF NOT EXISTS source_deliveries_run_idx
      ON source_deliveries(run_id);
    CREATE TABLE IF NOT EXISTS control_plane_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      subject TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS control_plane_events_type_idx
      ON control_plane_events(type);
    CREATE INDEX IF NOT EXISTS control_plane_events_severity_idx
      ON control_plane_events(severity);
    CREATE TABLE IF NOT EXISTS suggested_changes (
      proposal_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approval_decisions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, capability TEXT NOT NULL,
      resource_scope_json TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT,
      expires_at TEXT, constraints_json TEXT, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS grants_run_idx ON grants(run_id);
    CREATE INDEX IF NOT EXISTS grants_attempt_idx ON grants(attempt_id);
    CREATE TABLE IF NOT EXISTS material_actions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      action_family TEXT NOT NULL, capability TEXT NOT NULL, scope_json TEXT NOT NULL,
      target_json TEXT NOT NULL, risk_tier TEXT NOT NULL, status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, proposal_id TEXT, proposal_hash TEXT,
      decision_snapshot_hash TEXT, attempt_fence_digest TEXT NOT NULL, receipt_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    DROP INDEX IF EXISTS material_actions_idempotency_idx;
    CREATE INDEX IF NOT EXISTS material_actions_idempotency_idx ON material_actions(idempotency_key);
    CREATE INDEX IF NOT EXISTS material_actions_run_idx ON material_actions(run_id);
    CREATE INDEX IF NOT EXISTS material_actions_proposal_idx ON material_actions(proposal_id);
    CREATE TABLE IF NOT EXISTS apply_plans (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      approval_decision_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runners (
      runner_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      locality TEXT NOT NULL DEFAULT 'local',
      declared_state TEXT NOT NULL DEFAULT 'ready',
      executors_json TEXT NOT NULL DEFAULT '[]',
      max_concurrent_runs INTEGER NOT NULL DEFAULT 1000,
      preference INTEGER NOT NULL DEFAULT 0,
      claim_cursor_created_at TEXT,
      claim_cursor_run_id TEXT,
      created_at TEXT NOT NULL,
      heartbeat_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repo_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      fallback_runner_ids_json TEXT,
      workspace_path TEXT,
      default_executor TEXT,
      fallback_executor_ids_json TEXT,
      allowed_actors_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repo_bindings_provider_owner_repo_idx
      ON repo_bindings(provider, owner, repo);
    CREATE TABLE IF NOT EXISTS repo_policy_rules (
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repo_policy_rules_repo_id_idx
      ON repo_policy_rules(provider, owner, repo, id);
    CREATE TABLE IF NOT EXISTS repo_mutation_mappings (
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS repo_mutation_mappings_repo_id_idx
      ON repo_mutation_mappings(provider, owner, repo, id);
    CREATE TABLE IF NOT EXISTS linear_relay_installations (
      id TEXT PRIMARY KEY,
      webhook_path TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      token TEXT NOT NULL,
      auth_json TEXT,
      graphql_url TEXT,
      repo_provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      organization_id TEXT,
      team_id TEXT,
      team_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS linear_relay_installations_webhook_path_idx
      ON linear_relay_installations(webhook_path);
    CREATE TABLE IF NOT EXISTS linear_oauth_install_states (
      state TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      webhook_path TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      graphql_url TEXT,
      repo_provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      team_id TEXT,
      team_key TEXT,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS channel_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      repo_provider TEXT,
      owner TEXT,
      repo TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_provider_account_conversation_idx
      ON channel_bindings(provider, account_id, conversation_id);
    CREATE TABLE IF NOT EXISTS follow_up_requests (
      id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      active_run_id TEXT,
      workstream_id TEXT,
      admission_batch_id TEXT,
      event_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      access_profile_snapshot_json TEXT,
      policy_snapshot_provenance_json TEXT,
      routing_policy_json TEXT,
      status TEXT NOT NULL,
      created_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS follow_up_requests_source_event_idx
      ON follow_up_requests(source_event_id);
    CREATE INDEX IF NOT EXISTS follow_up_requests_conversation_idx
      ON follow_up_requests(conversation_key, status);
  `);
  const columns = sqlite.prepare("PRAGMA table_info(repo_bindings)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("workspace_path")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN workspace_path TEXT");
  }
  if (!columnNames.has("default_executor")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN default_executor TEXT");
  }
  if (!columnNames.has("allowed_actors_json")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN allowed_actors_json TEXT");
  }
  if (!columnNames.has("fallback_runner_ids_json")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN fallback_runner_ids_json TEXT");
  }
  if (!columnNames.has("fallback_executor_ids_json")) {
    sqlite.exec("ALTER TABLE repo_bindings ADD COLUMN fallback_executor_ids_json TEXT");
  }
  const runnerColumns = sqlite.prepare("PRAGMA table_info(runners)").all() as { name: string }[];
  const runnerColumnNames = new Set(runnerColumns.map((column) => column.name));
  if (!runnerColumnNames.has("locality")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN locality TEXT NOT NULL DEFAULT 'local'");
  }
  if (!runnerColumnNames.has("declared_state")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN declared_state TEXT NOT NULL DEFAULT 'ready'");
  }
  if (!runnerColumnNames.has("executors_json")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN executors_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!runnerColumnNames.has("max_concurrent_runs")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN max_concurrent_runs INTEGER NOT NULL DEFAULT 1000");
  }
  if (!runnerColumnNames.has("preference")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN preference INTEGER NOT NULL DEFAULT 0");
  }
  if (!runnerColumnNames.has("claim_cursor_created_at")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN claim_cursor_created_at TEXT");
  }
  if (!runnerColumnNames.has("claim_cursor_run_id")) {
    sqlite.exec("ALTER TABLE runners ADD COLUMN claim_cursor_run_id TEXT");
  }
  const followUpRoutingColumns = sqlite.prepare("PRAGMA table_info(follow_up_requests)").all() as { name: string }[];
  if (!followUpRoutingColumns.some((column) => column.name === "routing_policy_json")) {
    sqlite.exec("ALTER TABLE follow_up_requests ADD COLUMN routing_policy_json TEXT");
  }
  const channelBindingColumns = sqlite.prepare("PRAGMA table_info(channel_bindings)").all() as { name: string }[];
  const channelBindingColumnNames = new Set(channelBindingColumns.map((column) => column.name));
  if (!channelBindingColumnNames.has("repo_provider")) {
    sqlite.exec("ALTER TABLE channel_bindings ADD COLUMN repo_provider TEXT");
    sqlite.exec("UPDATE channel_bindings SET repo_provider = 'github' WHERE repo_provider IS NULL");
  }
  if (!channelBindingColumnNames.has("metadata_json")) {
    sqlite.exec("ALTER TABLE channel_bindings ADD COLUMN metadata_json TEXT");
  }
  const repositoryColumns = channelBindingColumns.filter((column) => ["repo_provider", "owner", "repo"].includes(column.name));
  if (repositoryColumns.some((column) => (column as { notnull?: number }).notnull === 1)) {
    sqlite.transaction(() => {
      sqlite.exec("DROP INDEX IF EXISTS channel_bindings_provider_account_conversation_idx");
      sqlite.exec(`
        CREATE TABLE channel_bindings_nullable_repo (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          repo_provider TEXT,
          owner TEXT,
          repo TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        )
      `);
      sqlite.exec(`
        INSERT INTO channel_bindings_nullable_repo (
          id, provider, account_id, conversation_id, repo_provider, owner, repo, metadata_json, created_at
        )
        SELECT id, provider, account_id, conversation_id, repo_provider, owner, repo, metadata_json, created_at
        FROM channel_bindings
      `);
      sqlite.exec("DROP TABLE channel_bindings");
      sqlite.exec("ALTER TABLE channel_bindings_nullable_repo RENAME TO channel_bindings");
      sqlite.exec(`
        CREATE UNIQUE INDEX channel_bindings_provider_account_conversation_idx
          ON channel_bindings(provider, account_id, conversation_id)
      `);
    })();
  }
  const runColumns = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  const runColumnNames = new Set(runColumns.map((column) => column.name));
  if (!runColumnNames.has("leased_at")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN leased_at TEXT");
  }
  if (!runColumnNames.has("context_packet_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN context_packet_json TEXT");
  }
  if (!runColumnNames.has("heartbeat_at")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN heartbeat_at TEXT");
  }
  if (!runColumnNames.has("parent_run_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT");
  }
  if (!runColumnNames.has("triggered_by_action_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN triggered_by_action_json TEXT");
  }
  if (!runColumnNames.has("source_proposal_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN source_proposal_id TEXT");
  }
  if (!runColumnNames.has("source_apply_plan_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN source_apply_plan_id TEXT");
  }
  if (!runColumnNames.has("repo_provider")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN repo_provider TEXT");
  }
  if (!runColumnNames.has("repo_owner")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN repo_owner TEXT");
  }
  if (!runColumnNames.has("repo_name")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN repo_name TEXT");
  }
  if (!runColumnNames.has("work_thread_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN work_thread_id TEXT");
  }
  if (!runColumnNames.has("conversation_key")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN conversation_key TEXT");
  }
  if (!runColumnNames.has("current_attempt_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN current_attempt_id TEXT");
  }
  if (!runColumnNames.has("current_routing_decision_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN current_routing_decision_id TEXT");
  }
  if (!runColumnNames.has("routing_policy_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN routing_policy_json TEXT");
  }
  if (!runColumnNames.has("routing_runner_ids_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN routing_runner_ids_json TEXT");
  }
  if (!runColumnNames.has("routing_executor_ids_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN routing_executor_ids_json TEXT");
  }
  if (!runColumnNames.has("routing_rejections_json")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN routing_rejections_json TEXT NOT NULL DEFAULT '[]'");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_repo_idx ON runs(repo_provider, repo_owner, repo_name)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_claim_queue_idx ON runs(status, created_at, id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_lease_recovery_idx ON runs(status, lease_expires_at, created_at, id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_work_thread_idx ON runs(work_thread_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_work_thread_authority_idx ON runs(work_thread_id, created_at, id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_key)");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      runner_id TEXT NOT NULL,
      fencing_token TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS attempts_run_number_idx ON attempts(run_id, number)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS attempts_run_idx ON attempts(run_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS attempts_runner_idx ON attempts(runner_id)");
  const attemptColumns = sqlite.prepare("PRAGMA table_info(attempts)").all() as { name: string }[];
  const attemptColumnNames = new Set(attemptColumns.map((column) => column.name));
  if (!attemptColumnNames.has("selected_executor_id")) {
    sqlite.exec("ALTER TABLE attempts ADD COLUMN selected_executor_id TEXT");
  }
  if (!attemptColumnNames.has("routing_decision_id")) {
    sqlite.exec("ALTER TABLE attempts ADD COLUMN routing_decision_id TEXT");
  }
  sqlite.exec(`
    UPDATE runs
    SET event_id = event_id || '#duplicate:' || id
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM runs
      GROUP BY event_id
    )
    AND event_id IN (
      SELECT event_id
      FROM runs
      GROUP BY event_id
      HAVING COUNT(*) > 1
    );
  `);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_source_event_id_idx ON runs(event_id)");
  const runEventColumns = sqlite.prepare("PRAGMA table_info(run_events)").all() as { name: string }[];
  const runEventColumnNames = new Set(runEventColumns.map((column) => column.name));
  if (!runEventColumnNames.has("visibility")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'audit'");
  }
  if (!runEventColumnNames.has("importance")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN importance TEXT NOT NULL DEFAULT 'normal'");
  }
  if (!runEventColumnNames.has("message")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN message TEXT");
  }
  if (!runEventColumnNames.has("progress_idempotency_digest")) {
    sqlite.exec("ALTER TABLE run_events ADD COLUMN progress_idempotency_digest TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS run_events_routing_latest_idx ON run_events(run_id, type, id)");
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS run_events_progress_idempotency_idx
      ON run_events(run_id, progress_idempotency_digest)
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS source_deliveries (
      source TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source, delivery_id)
    );
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS source_deliveries_run_idx ON source_deliveries(run_id)");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS control_plane_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      subject TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS control_plane_events_type_idx ON control_plane_events(type)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS control_plane_events_severity_idx ON control_plane_events(severity)");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_policy_rules_repo_id_idx ON repo_policy_rules(provider, owner, repo, id)");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_mutation_mappings_repo_id_idx ON repo_mutation_mappings(provider, owner, repo, id)");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS linear_relay_installations (
      id TEXT PRIMARY KEY,
      webhook_path TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      token TEXT NOT NULL,
      auth_json TEXT,
      graphql_url TEXT,
      repo_provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      organization_id TEXT,
      team_id TEXT,
      team_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS linear_relay_installations_webhook_path_idx ON linear_relay_installations(webhook_path)");
  const linearRelayInstallationColumns = sqlite.prepare("PRAGMA table_info(linear_relay_installations)").all() as { name: string }[];
  const linearRelayInstallationColumnNames = new Set(linearRelayInstallationColumns.map((column) => column.name));
  if (!linearRelayInstallationColumnNames.has("auth_json")) {
    sqlite.exec("ALTER TABLE linear_relay_installations ADD COLUMN auth_json TEXT");
  }
  if (!linearRelayInstallationColumnNames.has("organization_id")) {
    sqlite.exec("ALTER TABLE linear_relay_installations ADD COLUMN organization_id TEXT");
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS linear_relay_installations_organization_idx ON linear_relay_installations(organization_id)");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS linear_oauth_install_states (
      state TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      webhook_path TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      graphql_url TEXT,
      repo_provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      team_id TEXT,
      team_key TEXT,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  const legacySlackTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slack_channel_bindings'")
    .get() as { name: string } | undefined;
  if (legacySlackTable) {
    sqlite.exec(`
      INSERT OR IGNORE INTO channel_bindings (
        provider,
        account_id,
        conversation_id,
        repo_provider,
        owner,
        repo,
        created_at
      )
      SELECT
        'slack',
        team_id,
        channel_id,
        'github',
        owner,
        repo,
        created_at
      FROM slack_channel_bindings;
    `);
  }
  migrateCompletionGovernanceSchema(sqlite);
  migrateCompletionWaiverSchema(sqlite);
  migrateHumanEscalationAccessIdentitySchema(sqlite);
  migrateFactoryWorkstreamSchema(sqlite);
  migrateReassessmentObligationSchema(sqlite);
  migrateControlPlaneProjectionOutboxSchema(sqlite);
  migrateControlPlaneProjectionDependenciesSchema(sqlite);
  migrateControlPlaneProjectionEvidenceKindSchema(sqlite);
  migrateHostedRunImportSchema(sqlite);
  migrateHostedExecutionStartSchema(sqlite);
  migrateHostedClaimAuthorityShellSchema(sqlite);
  migrateHostedAttemptImportSchema(sqlite);
  migrateHostedHeartbeatOperationSchema(sqlite);
  migrateHostedLifecycleOperationSchema(sqlite);
}
