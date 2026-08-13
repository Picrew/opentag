const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const CREDENTIAL_VALUE = /(?:xox[baprs]-|Bearer\s|private.?key|password|secret)/iu;

export type SlackInstallationRecordV1 = Readonly<{ recordVersion: 1; installationId: string; teamId: string; appId: string;
  providerInstanceId: string; bindingDigest: string; principalDigest: string; principalAssurance: 'provider_verified' | 'configured_declared'; lifecycle: 'active';
  configGeneration: number; configGenerationDigest: string;
  credentialReference: Readonly<{ custody: 'local'; id: string }>; channelIds: readonly string[] }>;

function validate(record: SlackInstallationRecordV1): void {
  if (record.recordVersion !== 1 || ![record.installationId, record.teamId, record.appId, record.providerInstanceId,
    record.credentialReference.id, ...record.channelIds].every((value) => ID.test(value)) || record.credentialReference.custody !== 'local' || record.lifecycle !== 'active')
    throw new Error('Invalid Slack installation registry identity.');
  if (![record.bindingDigest, record.principalDigest, record.configGenerationDigest].every((value) => SHA256.test(value) && value !== ZERO_DIGEST))
    throw new Error('Invalid Slack installation registry digest.');
  if (CREDENTIAL_VALUE.test(record.credentialReference.id)) throw new Error('Slack installation credential reference contains credential material.');
  if (!Number.isSafeInteger(record.configGeneration) || record.configGeneration < 1 || record.channelIds.length < 1 || new Set(record.channelIds).size !== record.channelIds.length)
    throw new Error('Invalid Slack installation registry generation or channel scope.');
}

export function createSlackInstallationRegistry(input: readonly SlackInstallationRecordV1[]) {
  const records = new Map<string, SlackInstallationRecordV1>(); const authority = new Set<string>();
  for (const source of input) {
    validate(source); const record = Object.freeze({ ...source, credentialReference: Object.freeze({ ...source.credentialReference }), channelIds: Object.freeze([...source.channelIds]) });
    if (records.has(record.installationId)) throw new Error('Duplicate Slack installation record.');
    for (const channelId of record.channelIds) { const key = `${record.teamId}\0${record.appId}\0${channelId}`;
      if (authority.has(key)) throw new Error('Ambiguous Slack installation authority.'); authority.add(key); }
    records.set(record.installationId, record);
  }
  return Object.freeze({ findExact(query: { teamId: string; appId: string; channelId: string }): SlackInstallationRecordV1 | undefined {
    for (const record of records.values()) if (record.teamId === query.teamId && record.appId === query.appId && record.channelIds.includes(query.channelId)) return record;
  } });
}
