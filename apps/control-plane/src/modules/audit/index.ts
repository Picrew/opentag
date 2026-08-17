type Queryable = {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
};

export type ManagementAuditEvent = {
  organizationId: string;
  actor: {
    kind: "bootstrap" | "operator" | "recovery" | "runner" | "system";
    id: string;
  };
  operationKind: string;
  resource: { kind: string; id: string };
  outcome: string;
  event?: Record<string, unknown>;
  createdAt: Date | string;
};

export async function recordManagementAudit(
  client: Queryable,
  input: ManagementAuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO cp_management_audit_event(
       organization_id, actor_kind, actor_id, operation_kind,
       resource_kind, resource_id, outcome, event, created_at
     ) VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      input.organizationId,
      input.actor.kind,
      input.actor.id,
      input.operationKind,
      input.resource.kind,
      input.resource.id,
      input.outcome,
      JSON.stringify(input.event ?? {}),
      input.createdAt,
    ],
  );
}
