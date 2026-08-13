import { describe, expect, it } from 'vitest';

import * as contract from '../src/index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const common = {
  contractVersion: 2,
  sideEffectIntentId: 'intent_01',
  causalId: 'transition_01',
  provenance: {
    kind: 'business',
    repositoryIdentityDigest: digest,
    runId: 'run_01',
    authorityLineageDigest: digest,
  },
  providerBinding: {
    bindingKind: 'established',
    providerId: 'github',
    providerInstanceId: 'instance-01',
    connectionId: 'primary',
    connectionIdDigest: digest,
    providerPrincipalDigest: digest,
    principalAssurance: 'provider_verified',
    providerConfigGeneration: 1,
    providerConfigGenerationDigest: digest,
    lifecycle: 'active',
    bindingDigest: digest,
  },
  targetDigest: digest,
  authorityKind: 'run_authority',
  authoritySnapshotDigest: digest,
  evidencePolicy: 'local_audit',
  idempotencyKey: 'idem_01',
  scope: { kind: 'local_repository', id: digest },
  createdAt: '2026-08-13T00:00:00.000Z',
  initialAttemptSequence: 1,
};

const delivery = {
  ...common,
  intentKind: 'delivery',
  operation: 'create',
  deliveryKind: 'message',
  presentationDigest: digest,
};

describe('SideEffectIntentV2', () => {
  it('accepts only narrowly scoped runless source-thread control delivery', () => {
    const value = {
      contractVersion: 2, sideEffectIntentId: 'intent_control', causalId: 'causal_control',
      intentKind: 'delivery', operation: 'control_reply', deliveryKind: 'message',
      presentationDigest: digest,
      provenance: {
        kind: 'source_thread_control', providerInstanceId: common.providerBinding.providerInstanceId,
        inboundEventDigest: digest, sourceThreadDigest: digest,
        providerBindingDigest: common.providerBinding.bindingDigest,
        installationId: 'installation_control', runtimeGeneration: 1,
        scopeId: 'installation_control',
      },
      providerBinding: common.providerBinding, targetDigest: digest,
      authorityKind: 'local_source_thread_control', authoritySnapshotDigest: digest,
      evidencePolicy: 'local_audit', idempotencyKey: 'idem_control',
      scope: { kind: 'provider_instance', id: 'installation_control' },
      createdAt: '2026-08-13T00:00:00.000Z', initialAttemptSequence: 1,
      installationId: 'installation_control', runtimeGeneration: 1,
    };
    expect(contract.DeliveryIntentV2Schema.parse(value)).toEqual(value);
    expect(() => contract.DeliveryIntentV2Schema.parse({ ...value, operation: 'create' })).toThrow();
  });
  it('accepts a business delivery with an established provider binding', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(api.DeliveryIntentV2Schema.parse(delivery)).toMatchObject({
      intentKind: 'delivery',
      contractVersion: 2,
    });
  });

  it.each([
    ['delivery', { reviewedMaterialSelectorDigest: digest }],
    [
      'material_action',
      { ...delivery, intentKind: 'material_action', operation: 'mutate' },
    ],
    [
      'readback',
      { ...delivery, intentKind: 'readback', operation: 'reconcile' },
    ],
  ])('rejects unrelated or missing fields for %s', (_kind, value) => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(() => api.SideEffectIntentV2Schema.parse(value)).toThrow();
  });

  it('accepts strict material and readback variants', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(
      api.MaterialActionIntentV2Schema.parse({
        ...common,
        intentKind: 'material_action',
        operation: 'update_pull_request',
        reviewedMaterialSelectorDigest: digest,
        materialDigest: digest,
      }),
    ).toMatchObject({ intentKind: 'material_action' });
    expect(
      api.ReadbackIntentV2Schema.parse({
        ...common,
        intentKind: 'readback',
        operation: 'reconcile',
        authoritativeReadSelectorDigest: digest,
        priorAttemptId: 'attempt_01',
        priorResourceDigest: digest,
      }),
    ).toMatchObject({ intentKind: 'readback' });
  });

  it('rejects provisioning bindings for business intents', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const provisioning = {
      bindingKind: 'provisioning',
      providerId: 'github',
      providerInstanceId: 'instance-02',
      installationId: 'installation_01',
      runtimeGeneration: 2,
      providerApplicationDigest: digest,
      providerTenantDigest: digest,
      installationRequestDigest: digest,
      credentialSlotDigest: digest,
      provisioningRevision: 1,
      expectedPriorPrincipalDigest: null,
      expectedPriorConfigGeneration: 0,
      lifecycle: 'provisioning',
      bindingDigest: digest,
    };
    expect(() =>
      api.DeliveryIntentV2Schema.parse({
        ...delivery,
        providerBinding: provisioning,
      }),
    ).toThrow();
  });

  it('keeps business and credential scopes disjoint', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    expect(() =>
      api.DeliveryIntentV2Schema.parse({
        ...delivery,
        scope: { kind: 'provider_instance', id: 'installation:github:instance' },
      }),
    ).toThrow(/scope/iu);
  });

  it.each(['segment/child', '../instance', 'segment\\child'])(
    'rejects slash-bearing provider instance ID %s',
    (providerInstanceId) => {
      const api = contract as Record<string, { parse(value: unknown): unknown }>;
      expect(() =>
        api.DeliveryIntentV2Schema.parse({
          ...delivery,
          providerBinding: { ...common.providerBinding, providerInstanceId },
        }),
      ).toThrow();
    },
  );

  it('allows acquire only from a zero-generation provisioning binding', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const acquisition = {
      ...common,
      intentKind: 'credential_refresh',
      causalId: 'installation_request_01',
      provenance: {
        kind: 'provider_instance',
        installationId: 'installation_01',
        runtimeGeneration: 2,
      },
      providerBinding: {
        bindingKind: 'provisioning',
        providerId: 'github',
        providerInstanceId: 'instance-02',
        installationId: 'installation_01',
        runtimeGeneration: 2,
        providerApplicationDigest: digest,
        providerTenantDigest: digest,
        installationRequestDigest: digest,
        credentialSlotDigest: digest,
        provisioningRevision: 1,
        expectedPriorPrincipalDigest: null,
        expectedPriorConfigGeneration: 0,
        lifecycle: 'provisioning',
        bindingDigest: digest,
      },
      operation: 'acquire',
      installationId: 'installation_01',
      runtimeGeneration: 2,
      providerApplicationDigest: digest,
      providerTenantDigest: digest,
      installationRequestDigest: digest,
      credentialSlotDigest: digest,
      expectedPriorPrincipalDigest: null,
      expectedPriorConfigGeneration: 0,
      singleFlightKey: 'single_flight_01',
      scope: { kind: 'provider_instance', id: 'installation_01:github:instance-02' },
      authorityKind: 'provider_instance_authority',
    };

    expect(api.CredentialRefreshIntentV2Schema.parse(acquisition)).toMatchObject(
      { operation: 'acquire' },
    );
    expect(() =>
      api.CredentialRefreshIntentV2Schema.parse({
        ...acquisition,
        expectedPriorConfigGeneration: 1,
      }),
    ).toThrow();
  });

  it('requires refresh to bind the exact established principal and generation', () => {
    const api = contract as Record<string, { parse(value: unknown): unknown }>;
    const refresh = {
      ...common,
      intentKind: 'credential_refresh',
      provenance: {
        kind: 'provider_instance',
        installationId: 'installation_01',
        runtimeGeneration: 2,
      },
      operation: 'refresh',
      installationId: 'installation_01',
      runtimeGeneration: 2,
      providerApplicationDigest: digest,
      providerTenantDigest: digest,
      installationRequestDigest: digest,
      credentialSlotDigest: digest,
      expectedPriorPrincipalDigest: digest,
      expectedPriorConfigGeneration: 1,
      singleFlightKey: 'single_flight_01',
      scope: { kind: 'provider_instance', id: 'installation_01:github:instance-01' },
      authorityKind: 'provider_instance_authority',
    };
    expect(api.CredentialRefreshIntentV2Schema.parse(refresh)).toMatchObject({
      operation: 'refresh',
    });
    expect(() =>
      api.CredentialRefreshIntentV2Schema.parse({
        ...refresh,
        expectedPriorConfigGeneration: 2,
      }),
    ).toThrow();
  });
});
