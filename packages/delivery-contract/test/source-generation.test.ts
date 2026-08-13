import { describe, expect, it } from 'vitest';

import {
  SourceGenerationManifestV1Schema,
  createDraftSourceGenerationManifestV1,
} from '../src/source-generation.js';

const digest = `sha256:${'a'.repeat(64)}`;

describe('SourceGenerationManifestV1', () => {
  it('keeps an unknown production inventory draft untrusted and activation-blocked', () => {
    const manifest = createDraftSourceGenerationManifestV1({
      manifestId: 'source-generation-draft-01',
      generatedAt: '2026-08-13T00:00:00.000Z',
      targetSources: {
        opentag: {
          revision: '92c41240ea1d1173cbc4affc6c94f8136c3dddd3',
          treeDigest: digest,
          contentManifestDigest: digest,
        },
        cloud: {
          revision: '8a7a72f6aa7c4b1b2b6c77aa6eb358cfba6ba666',
          treeDigest: digest,
          contentManifestDigest: digest,
        },
      },
    });

    expect(SourceGenerationManifestV1Schema.parse(manifest)).toMatchObject({
      trustState: 'draft_untrusted',
      activationEligibility: {
        status: 'blocked',
        reasons: [
          'opentag_production_inventory_unknown',
          'cloud_production_inventory_unknown',
        ],
      },
      productionInventories: {
        opentag: { completeness: 'unverifiable', members: [] },
        cloud: { completeness: 'unverifiable', members: [] },
      },
    });
  });

  it('rejects a draft that claims activation eligibility', () => {
    const draft = createDraftSourceGenerationManifestV1({
      manifestId: 'source-generation-draft-02',
      generatedAt: '2026-08-13T00:00:00.000Z',
      targetSources: {
        opentag: {
          revision: '92c41240ea1d1173cbc4affc6c94f8136c3dddd3',
          treeDigest: digest,
          contentManifestDigest: digest,
        },
        cloud: {
          revision: '8a7a72f6aa7c4b1b2b6c77aa6eb358cfba6ba666',
          treeDigest: digest,
          contentManifestDigest: digest,
        },
      },
    });

    expect(() =>
      SourceGenerationManifestV1Schema.parse({
        ...draft,
        activationEligibility: { status: 'eligible', reasons: [] },
      }),
    ).toThrow();
  });

  it.each(['92c41240', 'main', '92C41240EA1D1173CBC4AFFC6C94F8136C3DDDD3'])(
    'rejects non-canonical git revision %s',
    (revision) => {
      expect(() => createDraftSourceGenerationManifestV1({
        manifestId: 'source-generation-invalid',
        generatedAt: '2026-08-13T00:00:00.000Z',
        targetSources: {
          opentag: { revision, treeDigest: digest, contentManifestDigest: digest },
          cloud: {
            revision: '8a7a72f6aa7c4b1b2b6c77aa6eb358cfba6ba666',
            treeDigest: digest,
            contentManifestDigest: digest,
          },
        },
      })).toThrow();
    },
  );
});
