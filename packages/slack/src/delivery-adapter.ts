import { EstablishedProviderBindingV1Schema, type DeliveryIntentV2, type EstablishedProviderBindingV1 } from '@opentag/delivery-contract';
import { createSlackPostMessagePayload, createSlackReactionPayload, createSlackUpdateMessagePayload, type SlackBlock } from './render.js';

export type SlackDeliveryOperation = { kind: 'create_message'; channelId: string; threadTs?: string } | { kind: 'update_message' | 'add_reaction'; channelId: string; messageTs: string };
export type SlackDeliveryPresentation = { kind: 'message'; text: string; textFormat?: 'markdown' | 'mrkdwn'; blocks?: SlackBlock[] }
  | { kind: 'reaction'; name: string };
const BINDING_FIELDS = ['providerId', 'providerInstanceId', 'bindingDigest',
  'providerPrincipalDigest', 'providerConfigGeneration', 'providerConfigGenerationDigest'] as const;
type BindingDescriptor = Pick<EstablishedProviderBindingV1, typeof BINDING_FIELDS[number]>;
type SlackDescriptor = Readonly<{ providerId: 'slack' } & Omit<BindingDescriptor, 'providerId'>>;
type SlackDeliveryResult = { outcome: 'accepted' | 'rejected' | 'outcome_unknown' | 'attention'; evidenceDigest: string; externalResourceId?: string; errorCode?: string };
export type SlackDeliveryAdapter = SlackDescriptor & {
  deliver(input: { intent: DeliveryIntentV2; operation: SlackDeliveryOperation; presentation: SlackDeliveryPresentation; signal?: AbortSignal }): Promise<SlackDeliveryResult> };
type SlackDeliveryAdapterOptions = Omit<SlackDescriptor, 'providerId'> & {
  resolveCredential(input: SlackDescriptor & { signal: AbortSignal }): Promise<string>; fetchImpl?: typeof fetch; deadlineMs?: number };

const API = 'https://slack.com/api/'; const SLACK_TS = /^\d{1,20}\.\d{1,20}$/u;

async function result(outcome: SlackDeliveryResult['outcome'], evidence: unknown, extras: Omit<SlackDeliveryResult, 'outcome' | 'evidenceDigest'> = {}): Promise<SlackDeliveryResult> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(evidence))); const evidenceDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { outcome, evidenceDigest: `sha256:${evidenceDigest}`, ...extras };
}

function failed(outcome: SlackDeliveryResult['outcome'], errorCode: string, evidence: unknown): Promise<SlackDeliveryResult> { return result(outcome, evidence, { errorCode }); }

function bindingMatches(left: BindingDescriptor, right: BindingDescriptor): boolean { return BINDING_FIELDS.every((field) => left[field] === right[field]); }

function requestFor(operation: SlackDeliveryOperation, presentation: SlackDeliveryPresentation): { method: string; payload: object; resourceId?: string } | undefined {
  if (operation.kind === 'create_message' && presentation.kind === 'message') {
    const payload = createSlackPostMessagePayload({ channelId: operation.channelId, text: presentation.text, ...(presentation.textFormat ? { textFormat: presentation.textFormat } : {}), threadTs: operation.threadTs ?? '', ...(presentation.blocks ? { blocks: presentation.blocks } : {}) });
    if (!operation.threadTs) delete payload.thread_ts;
    return { method: 'chat.postMessage', payload };
  }
  if (operation.kind === 'update_message' && presentation.kind === 'message') { return { method: 'chat.update', payload: createSlackUpdateMessagePayload({ channelId: operation.channelId, messageTs: operation.messageTs, text: presentation.text,
      ...(presentation.textFormat ? { textFormat: presentation.textFormat } : {}), ...(presentation.blocks ? { blocks: presentation.blocks } : {}) }) };
  }
  if (operation.kind === 'add_reaction' && presentation.kind === 'reaction' && SLACK_TS.test(operation.messageTs)) { return { method: 'reactions.add', payload: createSlackReactionPayload({ channelId: operation.channelId, messageTs: operation.messageTs, name: presentation.name }), resourceId: operation.messageTs };
  }
  return undefined;
}

function intentMatches(intent: DeliveryIntentV2, operation: SlackDeliveryOperation): boolean { if (operation.kind === 'create_message') return intent.deliveryKind === 'message' && (intent.operation === 'create' || intent.operation === 'control_reply');
  if (operation.kind === 'update_message') return intent.deliveryKind === 'message' && intent.operation === 'update';
  return intent.deliveryKind === 'reaction' && intent.operation === 'create';
}

export function createSlackDeliveryAdapter(options: SlackDeliveryAdapterOptions): SlackDeliveryAdapter {
  const { resolveCredential, fetchImpl = fetch, deadlineMs = 10_000, ...bindingFields } = options;
  const descriptor = Object.freeze({ providerId: 'slack' as const, ...bindingFields });
  EstablishedProviderBindingV1Schema.parse({ bindingKind: 'established', ...descriptor, principalAssurance: 'configured_declared', lifecycle: 'active' });
  return Object.freeze({
    ...descriptor,
    async deliver(input) {
      const binding = input.intent.providerBinding; if (binding.bindingKind !== 'established' || binding.lifecycle !== 'active' || !bindingMatches(binding, descriptor)) {
        return failed('attention', 'provider_binding_mismatch', { code: 'provider_binding_mismatch' });
      }
      const request = requestFor(input.operation, input.presentation); if (!request || !intentMatches(input.intent, input.operation)) {
        return failed('attention', 'invalid_delivery_shape', { code: 'invalid_delivery_shape' });
      }

      const controller = new AbortController(); let deadlineExceeded = false; let timer!: ReturnType<typeof setTimeout>;
      const onAbort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        deadlineExceeded = true; controller.abort(); reject(); }, deadlineMs); });
      try {
        const credential = resolveCredential({ ...descriptor, signal: controller.signal });
        const token = await Promise.race([credential, deadline]);
        const response = await Promise.race([fetchImpl(`${API}${request.method}`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(request.payload), signal: controller.signal,
        }), deadline]);
        const responseEvidence = { method: request.method, status: response.status }; if (response.status >= 500) return failed('outcome_unknown', 'provider_5xx', responseEvidence);
        let body: unknown; try { body = await response.json(); } catch { return failed('outcome_unknown', 'malformed_response', responseEvidence); }
        if (!body || typeof body !== 'object' || !('ok' in body) || typeof body.ok !== 'boolean') {
          return failed('outcome_unknown', 'malformed_response', responseEvidence); }
        if (!body.ok) return failed('rejected', 'slack_rejected', { ...responseEvidence, ok: false });
        const responseTs = 'ts' in body && typeof body.ts === 'string' && SLACK_TS.test(body.ts) ? body.ts : undefined; const resourceId = responseTs ?? request.resourceId;
        if (!resourceId) return failed('outcome_unknown', 'ambiguous_response', { ...responseEvidence, ok: true });
        return result('accepted', { ...responseEvidence, ok: true, ts: resourceId }, { externalResourceId: resourceId });
      } catch {
        const errorCode = deadlineExceeded ? 'deadline_exceeded' : 'transport_error'; return failed('outcome_unknown', errorCode, { method: request.method, code: errorCode });
      } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort); }
    },
  });
}
