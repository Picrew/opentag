import { createHash } from 'node:crypto';
import { DeliveryIntentV2Schema, domainSeparatedCanonicalBytes, type DeliveryIntentV2, type EstablishedProviderBindingV1 } from '@opentag/delivery-contract';
import { parseSlackThreadKey, slackSourceReceiptReactionName, type SlackDeliveryAdapter, type SlackDeliveryOperation, type SlackDeliveryPresentation } from '@opentag/slack';
import type { SlackInstallationRecordV1 } from '@opentag/store';
import type { DispatcherDeliveryPresentation } from '../server.js';
import { ProviderAdapterRegistry } from './provider-registry.js';
import { UnifiedDeliveryProducer } from './producer.js';
import { ProviderSideEffectKernel, type DeliveryKernelRepository } from './side-effect-kernel.js';

type SlackRequest = { operation: SlackDeliveryOperation; presentation: SlackDeliveryPresentation; statusMessageId?: string; expectedResourceDigest?: string };
export type SlackDeliveryAuthority = { providerBinding: EstablishedProviderBindingV1; authoritySnapshotIdentity: string; causalId: string; createdAt: string; provenance:
  { kind: 'business'; repositoryIdentity: string; authorityLineageIdentity: string; scopeId: string } | { kind: 'source_thread_control'; inboundEventIdentity: string; sourceThreadIdentity: string; installationId: string; runtimeGeneration: number; scopeId: string } };
type SlackLifecycleCompositionOptions = { repository: DeliveryKernelRepository; adapter: SlackDeliveryAdapter; resolveAuthority(presentation: DispatcherDeliveryPresentation): Promise<SlackDeliveryAuthority | null> };
type SlackInstallationRegistryReader = { findExact(input: { teamId: string; appId: string; channelId: string }): SlackInstallationRecordV1 | undefined };

export function createSlackSelfServiceAuthorityResolver(input: { registry: SlackInstallationRegistryReader; runtimeGeneration: number; authoritySnapshotIdentity: string }) {
  if (!Number.isSafeInteger(input.runtimeGeneration) || input.runtimeGeneration < 1 || !input.authoritySnapshotIdentity) throw new Error('Explicit Slack runtime authority is required.');
  return async (presentation: DispatcherDeliveryPresentation): Promise<SlackDeliveryAuthority | null> => {
    if (presentation.kind !== 'source_thread_control') return null; const metadata = presentation.request.metadata;
    const eventId = metadata?.slackEventId; const eventTime = metadata?.eventTime; const appId = metadata?.appId; const key = presentation.request.callback.threadKey;
    if (typeof eventId !== 'string' || typeof eventTime !== 'number' || !Number.isSafeInteger(eventTime) || eventTime < 0 || typeof appId !== 'string' || !key) return null;
    let target: ReturnType<typeof parseSlackThreadKey>; try { target = parseSlackThreadKey(key); } catch { return null; }
    const record = input.registry.findExact({ teamId: target.teamId, appId, channelId: target.channelId }); if (!record) return null;
    const createdAt = new Date(eventTime * 1_000); if (Number.isNaN(createdAt.valueOf())) return null;
    return { providerBinding: { bindingKind: 'established', providerId: 'slack', providerInstanceId: record.providerInstanceId, providerPrincipalDigest: record.principalDigest,
        principalAssurance: record.principalAssurance, bindingDigest: record.bindingDigest, providerConfigGeneration: record.configGeneration, providerConfigGenerationDigest: record.configGenerationDigest, lifecycle: record.lifecycle },
      authoritySnapshotIdentity: input.authoritySnapshotIdentity, causalId: eventId, createdAt: createdAt.toISOString(), provenance: { kind: 'source_thread_control', inboundEventIdentity: eventId,
        sourceThreadIdentity: key, installationId: record.installationId, runtimeGeneration: input.runtimeGeneration, scopeId: record.providerInstanceId } };
  }; }

function requestFor(presentation: DispatcherDeliveryPresentation): SlackRequest | null {
  if (presentation.kind === 'source_receipt') { const channelId = presentation.sourceEvent?.metadata['channelId']; const messageTs = presentation.sourceEvent?.metadata['messageTs'];
    if (typeof channelId !== 'string' || typeof messageTs !== 'string' || (presentation.phase !== 'received' && presentation.phase !== 'running')) return null;
    return { operation: { kind: 'add_reaction', channelId, messageTs }, presentation: { kind: 'reaction', name: slackSourceReceiptReactionName(presentation.phase) } };
  }
  const key = presentation.kind === 'source_thread_control' ? presentation.request.callback.threadKey : presentation.threadKey; if (!key) return null;
  try { const { channelId, threadTs } = parseSlackThreadKey(key); const message: SlackDeliveryPresentation = { kind: 'message', text: presentation.body ?? '',
      textFormat: presentation.kind === 'source_thread_control' ? presentation.textFormat ?? 'mrkdwn' : 'mrkdwn', ...(presentation.blocks?.length ? { blocks: presentation.blocks } : {}) };
    return { operation: { kind: 'create_message', channelId, threadTs }, presentation: message,
      ...(presentation.kind === 'business' && presentation.statusMessageKey ? { statusMessageId: presentation.statusMessageKey } : {}) };
  } catch { return null; }
}

const hash = (domain: string, value: unknown) => `sha256:${createHash('sha256').update(domainSeparatedCanonicalBytes(domain, value)).digest('hex')}`; const stableId = (prefix: string, value: unknown) => `${prefix}_${hash('opentag.delivery.slack-id.v1', value).slice(7, 31)}`;
const requestDigests = (request: SlackRequest) => ({ presentationDigest: hash('opentag.delivery.slack-presentation.v1', request.presentation),
  targetDigest: hash('opentag.delivery.slack-target.v1', request.operation.kind === 'add_reaction' ? request.operation : { channelId: request.operation.channelId, threadTs: 'threadTs' in request.operation ? request.operation.threadTs : undefined }) });
function intentFor(authority: SlackDeliveryAuthority, presentation: DispatcherDeliveryPresentation, request: SlackRequest, operation: DeliveryIntentV2['operation']): DeliveryIntentV2 { const control = presentation.kind === 'source_thread_control';
  const { presentationDigest, targetDigest } = requestDigests(request);
  const identity = { causalId: authority.causalId, operation, presentationDigest, targetDigest, statusMessageId: request.statusMessageId ?? null };
  const provenance = control && authority.provenance.kind === 'source_thread_control' ? { kind: 'source_thread_control' as const, providerInstanceId: authority.providerBinding.providerInstanceId,
      inboundEventDigest: hash('opentag.delivery.inbound-event.v1', authority.provenance.inboundEventIdentity), sourceThreadDigest: hash('opentag.delivery.source-thread.v1', authority.provenance.sourceThreadIdentity), providerBindingDigest: authority.providerBinding.bindingDigest,
      installationId: authority.provenance.installationId, runtimeGeneration: authority.provenance.runtimeGeneration, scopeId: authority.provenance.scopeId }
    : !control && authority.provenance.kind === 'business' ? { kind: 'business' as const, repositoryIdentityDigest: hash('opentag.delivery.repository.v1', authority.provenance.repositoryIdentity),
      runId: presentation.runId, authorityLineageDigest: hash('opentag.delivery.authority-lineage.v1', authority.provenance.authorityLineageIdentity) } : null;
  if (!provenance || (provenance.kind === 'business' && !provenance.runId)) throw new Error('Slack authority provenance mismatch.');
  return DeliveryIntentV2Schema.parse({ contractVersion: 2, sideEffectIntentId: stableId('intent', identity), causalId: authority.causalId, intentKind: 'delivery', operation, deliveryKind: request.presentation.kind === 'reaction' ? 'reaction' : 'message',
    presentationDigest, provenance, providerBinding: authority.providerBinding, targetDigest, authorityKind: control ? 'local_source_thread_control' : 'run_authority', authoritySnapshotDigest: hash('opentag.delivery.authority-snapshot.v1', authority.authoritySnapshotIdentity),
    evidencePolicy: 'local_audit', idempotencyKey: stableId('delivery', identity), scope: control ? { kind: 'provider_instance', id: authority.providerBinding.providerInstanceId } : { kind: 'local_repository', id: authority.provenance.scopeId }, createdAt: authority.createdAt,
    initialAttemptSequence: 1, ...(request.statusMessageId ? { statusMessageId: request.statusMessageId } : {}),
    ...(control && authority.provenance.kind === 'source_thread_control' ? { installationId: authority.provenance.installationId, runtimeGeneration: authority.provenance.runtimeGeneration } : {}) }); }

export function createSlackLifecycleComposition(options: SlackLifecycleCompositionOptions) {
  const kernel = new ProviderSideEffectKernel<SlackRequest>({ repository: options.repository, registry: new ProviderAdapterRegistry<SlackRequest>().register(options.adapter),
    prepareRequest: (intent, payload) => { const stored = payload as SlackRequest; let operation = stored.operation;
      if (intent.operation === 'update' && stored.statusMessageId) { const prior = options.repository.findAcceptedExternalResource({ intent, statusMessageId: stored.statusMessageId });
        if (prior.outcome !== 'exact' || prior.externalResourceDigest !== stored.expectedResourceDigest || operation.kind !== 'create_message') throw new Error('Exact accepted Slack lifecycle resource unavailable.');
        operation = { kind: 'update_message', channelId: operation.channelId, messageTs: prior.externalResourceId }; } return { request: { ...stored, operation }, operation: intent.operation, ...requestDigests(stored) }; } });
  const producer = new UnifiedDeliveryProducer<DispatcherDeliveryPresentation>({ submitter: kernel,
    resolveIntent: async (presentation) => {
      if ((presentation.kind !== 'source_thread_control' && presentation.provider !== 'slack') || (presentation.kind === 'source_thread_control' && presentation.request.callback.provider !== 'slack')) return null;
      const authority = await options.resolveAuthority(presentation); if (!authority || authority.providerBinding.providerId !== 'slack') return null;
      const request = requestFor(presentation); if (!request) return null;
      let operation: DeliveryIntentV2['operation'] = presentation.kind === 'source_thread_control' ? 'control_reply' : 'create';
      if (request.statusMessageId) { const prior = options.repository.findAcceptedExternalResource({ intent: intentFor(authority, presentation, request, 'create'),
          statusMessageId: request.statusMessageId });
        if (prior.outcome === 'ambiguous' || (prior.outcome === 'none' && presentation.kind === 'business' && presentation.phase !== 'acknowledgement')) return null;
        if (prior.outcome === 'exact') { operation = 'update'; request.expectedResourceDigest = prior.externalResourceDigest; }
      }
      const intent = intentFor(authority, presentation, request, operation); return { intent, persistedPayload: request };
    } });
  return { producer, kernel };
}
