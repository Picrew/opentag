const BLOCKED_STATE = Object.freeze({
  active: false, status: 'blocked', releaseStatus: 'non_releasable',
  reasons: Object.freeze([
    'full_provider_root_set_incomplete', 'cloud_consumer_cutover_incomplete',
    'production_inventory_incomplete', 'migration_incomplete', 'operations_incomplete',
  ] as const),
} as const);

export function getUnifiedDeliveryActivationState(
  _attemptedOverride?: unknown,
): typeof BLOCKED_STATE { return BLOCKED_STATE; }
