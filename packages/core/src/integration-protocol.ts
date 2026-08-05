import { z } from "zod";

const ProviderDataSchema = z.record(z.string(), z.unknown());

export const OpenTagIntegrationProtocolVersionSchema = z.literal("opentag.integration.v1");
export const OpenTagAgentProtocolSchema = z.literal("agent-client-protocol");
export const OpenTagAgentProtocolVersionSchema = z.literal(1);
export const OpenTagChannelProtocolSchema = z.literal("opentag.channel.v1");
export const OpenTagStdioBindingKindSchema = z.literal("stdio");

function isExecutableNameOrAbsolutePath(command: string): boolean {
  const segments = command.split(/[\\/]/u);
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  if (!command.includes("/") && !command.includes("\\")) return !command.includes(":");
  if (command.startsWith("/")) return command.length > 1;
  return /^[A-Za-z]:[\\/].+/u.test(command);
}

export const OpenTagStdioBindingSchema = z
  .object({
    kind: OpenTagStdioBindingKindSchema,
    command: z
      .string()
      .trim()
      .min(1)
      .refine(isExecutableNameOrAbsolutePath, "Stdio command must be an executable name or an absolute path."),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional()
  })
  .strict();

export const OpenTagIntegrationBindingSchema = OpenTagStdioBindingSchema;

export const OpenTagAgentWorkspaceConformanceSchema = z
  .object({
    sessionCwd: z.literal("required")
  })
  .strict();

export const OpenTagAgentIntegrationRoleSchema = z
  .object({
    protocol: OpenTagAgentProtocolSchema,
    protocolVersion: OpenTagAgentProtocolVersionSchema,
    binding: z.string().trim().min(1),
    workspace: OpenTagAgentWorkspaceConformanceSchema
  })
  .strict();

export const OpenTagManagedChannelOwnershipSchema = z
  .object({
    mode: z.literal("managed"),
    exclusive: z.literal(true)
  })
  .strict();

export const OpenTagChannelIntegrationRoleSchema = z
  .object({
    protocol: OpenTagChannelProtocolSchema,
    binding: z.string().trim().min(1),
    ownership: OpenTagManagedChannelOwnershipSchema
  })
  .strict();

export const OpenTagIntegrationRolesSchema = z
  .object({
    agent: OpenTagAgentIntegrationRoleSchema.optional(),
    channel: OpenTagChannelIntegrationRoleSchema.optional()
  })
  .strict();

export const OpenTagResourceCapabilitySchema = z
  .object({
    refs: z.boolean().default(true),
    read: z.boolean().default(false),
    write: z.boolean().default(false),
    comments: z.boolean().optional(),
    status: z.boolean().optional()
  })
  .strict();

export const OpenTagIntegrationResourcesSchema = z.record(z.string(), OpenTagResourceCapabilitySchema).default({});

export const OpenTagIntegrationManifestSchema = z
  .object({
    protocol: OpenTagIntegrationProtocolVersionSchema,
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    bindings: z.record(z.string(), OpenTagIntegrationBindingSchema),
    roles: OpenTagIntegrationRolesSchema,
    resources: OpenTagIntegrationResourcesSchema
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (Object.keys(manifest.bindings).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bindings"],
        message: "Integration manifest must declare at least one binding."
      });
    }
    for (const roleName of ["agent", "channel"] as const) {
      const role = manifest.roles[roleName];
      if (role && !Object.prototype.hasOwnProperty.call(manifest.bindings, role.binding)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", roleName, "binding"],
          message: `${roleName === "agent" ? "Agent" : "Channel"} role references missing binding '${role.binding}'.`
        });
      }
    }
  });

export const OpenTagActorRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagChannelRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1).optional(),
    workspace: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagThreadRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    parentMessageId: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagRepoRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    name: z.string().trim().min(1),
    url: z.string().trim().min(1).optional(),
    defaultBranch: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagChangeRequestRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    repo: OpenTagRepoRefSchema.optional(),
    id: z.string().trim().min(1),
    number: z.number().int().positive().optional(),
    title: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    sourceBranch: z.string().trim().min(1).optional(),
    targetBranch: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagWorkItemRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagContextRefKindSchema = z.enum(["doc", "wiki", "file", "search", "memory", "thread", "issue", "change_request", "url"]);

export const OpenTagContextRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    kind: OpenTagContextRefKindSchema,
    id: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagRunSourceKindSchema = z.enum(["channel_message", "automation", "api", "webhook"]);

export const OpenTagRunSourceRefSchema = z
  .object({
    kind: OpenTagRunSourceKindSchema,
    channel: OpenTagChannelRefSchema.optional(),
    thread: OpenTagThreadRefSchema.optional(),
    actor: OpenTagActorRefSchema.optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagRunTargetsSchema = z
  .object({
    repo: OpenTagRepoRefSchema.optional(),
    changeRequest: OpenTagChangeRequestRefSchema.optional(),
    workItem: OpenTagWorkItemRefSchema.optional(),
    context: z.array(OpenTagContextRefSchema).default([])
  })
  .strict();

export const OpenTagReplyPurposeSchema = z.enum(["all", "progress", "final", "error", "approval"]);
export const OpenTagReplyDeliveryPurposeSchema = OpenTagReplyPurposeSchema.exclude(["all"]);

export const OpenTagReplyTargetRefSchema = z
  .object({
    channel: OpenTagChannelRefSchema,
    thread: OpenTagThreadRefSchema.optional(),
    purpose: OpenTagReplyPurposeSchema.default("all"),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export type OpenTagIntegrationProtocolVersion = z.infer<typeof OpenTagIntegrationProtocolVersionSchema>;
export type OpenTagAgentProtocol = z.infer<typeof OpenTagAgentProtocolSchema>;
export type OpenTagAgentProtocolVersion = z.infer<typeof OpenTagAgentProtocolVersionSchema>;
export type OpenTagChannelProtocol = z.infer<typeof OpenTagChannelProtocolSchema>;
export type OpenTagStdioBindingKind = z.infer<typeof OpenTagStdioBindingKindSchema>;
export type OpenTagStdioBindingInput = z.input<typeof OpenTagStdioBindingSchema>;
export type OpenTagStdioBinding = z.infer<typeof OpenTagStdioBindingSchema>;
export type OpenTagIntegrationBinding = z.infer<typeof OpenTagIntegrationBindingSchema>;
export type OpenTagAgentWorkspaceConformance = z.infer<typeof OpenTagAgentWorkspaceConformanceSchema>;
export type OpenTagAgentIntegrationRoleInput = z.input<typeof OpenTagAgentIntegrationRoleSchema>;
export type OpenTagAgentIntegrationRole = z.infer<typeof OpenTagAgentIntegrationRoleSchema>;
export type OpenTagManagedChannelOwnership = z.infer<typeof OpenTagManagedChannelOwnershipSchema>;
export type OpenTagChannelIntegrationRoleInput = z.input<typeof OpenTagChannelIntegrationRoleSchema>;
export type OpenTagChannelIntegrationRole = z.infer<typeof OpenTagChannelIntegrationRoleSchema>;
export type OpenTagIntegrationRoles = z.infer<typeof OpenTagIntegrationRolesSchema>;
export type OpenTagResourceCapability = z.infer<typeof OpenTagResourceCapabilitySchema>;
export type OpenTagIntegrationResources = z.infer<typeof OpenTagIntegrationResourcesSchema>;
export type OpenTagIntegrationManifestInput = z.input<typeof OpenTagIntegrationManifestSchema>;
export type OpenTagIntegrationManifest = z.infer<typeof OpenTagIntegrationManifestSchema>;
export type OpenTagActorRef = z.infer<typeof OpenTagActorRefSchema>;
export type OpenTagChannelRef = z.infer<typeof OpenTagChannelRefSchema>;
export type OpenTagThreadRef = z.infer<typeof OpenTagThreadRefSchema>;
export type OpenTagRepoRef = z.infer<typeof OpenTagRepoRefSchema>;
export type OpenTagChangeRequestRef = z.infer<typeof OpenTagChangeRequestRefSchema>;
export type OpenTagWorkItemRef = z.infer<typeof OpenTagWorkItemRefSchema>;
export type OpenTagContextRefKind = z.infer<typeof OpenTagContextRefKindSchema>;
export type OpenTagContextRef = z.infer<typeof OpenTagContextRefSchema>;
export type OpenTagRunSourceKind = z.infer<typeof OpenTagRunSourceKindSchema>;
export type OpenTagRunSourceRef = z.infer<typeof OpenTagRunSourceRefSchema>;
export type OpenTagRunTargets = z.infer<typeof OpenTagRunTargetsSchema>;
export type OpenTagReplyPurpose = z.infer<typeof OpenTagReplyPurposeSchema>;
export type OpenTagReplyDeliveryPurpose = z.infer<typeof OpenTagReplyDeliveryPurposeSchema>;
export type OpenTagReplyTargetRef = z.infer<typeof OpenTagReplyTargetRefSchema>;

export function selectReplyTargetsForPurpose(
  replyTo: readonly OpenTagReplyTargetRef[],
  purpose: OpenTagReplyDeliveryPurpose
): OpenTagReplyTargetRef[] {
  return replyTo.filter((target) => target.purpose === "all" || target.purpose === purpose);
}
