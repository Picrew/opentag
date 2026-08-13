import { describe, expect, it } from 'vitest';
import { getUnifiedDeliveryActivationState } from '../../src/delivery/activation-state.js';

describe('Task 4 unified delivery activation', () => {
  it('is explicitly blocked and non-releasable', () => {
    expect(getUnifiedDeliveryActivationState()).toEqual({
      active: false,
      status: 'blocked',
      releaseStatus: 'non_releasable',
      reasons: [
        'full_provider_root_set_incomplete',
        'cloud_consumer_cutover_incomplete',
        'production_inventory_incomplete',
        'migration_incomplete',
        'operations_incomplete',
      ],
    });
  });

  it('cannot be enabled by environment, config, or registry input', () => {
    const attemptedOverrides = {
      env: { OPENTAG_UNIFIED_DELIVERY: 'active' },
      config: { unifiedDelivery: { active: true, releasable: true } },
      registry: { slack: { registered: true, active: true } },
    };

    expect(getUnifiedDeliveryActivationState(attemptedOverrides)).toEqual(
      getUnifiedDeliveryActivationState(),
    );
  });
});
