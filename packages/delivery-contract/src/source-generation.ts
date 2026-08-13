import { z } from 'zod';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const nonEmpty = z.string().min(1);
const gitCommitId = z.string().regex(/^[a-f0-9]{40}$/u);

const TargetSourceSchema = z
  .object({
    revision: gitCommitId,
    treeDigest: digest,
    contentManifestDigest: digest,
  })
  .strict();

const UnverifiableInventorySchema = z
  .object({
    completeness: z.literal('unverifiable'),
    members: z.array(z.never()).length(0),
  })
  .strict();

export const SourceGenerationManifestV1Schema = z
  .object({
    schemaVersion: z.literal('SourceGenerationManifestV1'),
    manifestId: nonEmpty,
    generatedAt: timestamp,
    trustState: z.literal('draft_untrusted'),
    targetSources: z
      .object({
        opentag: TargetSourceSchema,
        cloud: TargetSourceSchema,
      })
      .strict(),
    productionInventories: z
      .object({
        opentag: UnverifiableInventorySchema,
        cloud: UnverifiableInventorySchema,
      })
      .strict(),
    activationEligibility: z
      .object({
        status: z.literal('blocked'),
        reasons: z.tuple([
          z.literal('opentag_production_inventory_unknown'),
          z.literal('cloud_production_inventory_unknown'),
        ]),
      })
      .strict(),
  })
  .strict();

export type SourceGenerationManifestV1 = z.infer<
  typeof SourceGenerationManifestV1Schema
>;

export function createDraftSourceGenerationManifestV1(input: {
  manifestId: string;
  generatedAt: string;
  targetSources: SourceGenerationManifestV1['targetSources'];
}): SourceGenerationManifestV1 {
  return SourceGenerationManifestV1Schema.parse({
    schemaVersion: 'SourceGenerationManifestV1',
    manifestId: input.manifestId,
    generatedAt: input.generatedAt,
    trustState: 'draft_untrusted',
    targetSources: input.targetSources,
    productionInventories: {
      opentag: { completeness: 'unverifiable', members: [] },
      cloud: { completeness: 'unverifiable', members: [] },
    },
    activationEligibility: {
      status: 'blocked',
      reasons: [
        'opentag_production_inventory_unknown',
        'cloud_production_inventory_unknown',
      ],
    },
  });
}
