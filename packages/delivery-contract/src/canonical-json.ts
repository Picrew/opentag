export type StrictJson =
  | null
  | boolean
  | number
  | string
  | StrictJson[]
  | { [key: string]: StrictJson };

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
          throw new TypeError('Canonical JSON rejects unpaired Unicode surrogates.');
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new TypeError('Canonical JSON rejects unpaired Unicode surrogates.');
      }
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are not strict JSON.');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${typeof value} is not strict JSON.`);
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot contain a cycle.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('Canonical JSON does not accept symbol keys.');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Canonical JSON does not accept sparse arrays.');
      }
      const allowed = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
      const extraKeys = Reflect.ownKeys(value).filter((key) => typeof key !== 'string' || !allowed.has(key));
      if (extraKeys.length > 0) throw new TypeError('Canonical JSON does not accept named array properties.');
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) {
          throw new TypeError('Canonical JSON does not accept accessor array indices.');
        }
        if (!descriptor.enumerable) {
          throw new TypeError('Canonical JSON does not accept non-enumerable array indices.');
        }
        entries.push(serialize(descriptor.value, ancestors));
      }
      return `[${entries.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain object prototypes.');
    }
    const record = value as Record<string, unknown>;
    if (Object.getOwnPropertySymbols(record).length > 0) {
      throw new TypeError('Canonical JSON does not accept symbol keys.');
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(record))) {
      if (descriptor.get || descriptor.set) {
        throw new TypeError('Canonical JSON does not accept accessor properties.');
      }
      if (!descriptor.enumerable) throw new TypeError('Canonical JSON does not accept non-enumerable properties.');
    }
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${serialize(key, ancestors)}:${serialize(record[key], ancestors)}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function domainSeparatedCanonicalBytes(domain: string, value: unknown): Uint8Array {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(domain)) throw new TypeError('Invalid digest domain.');
  const domainBytes = new TextEncoder().encode(domain);
  const valueBytes = canonicalJsonBytes(value);
  const framed = new Uint8Array(domainBytes.length + 1 + valueBytes.length);
  framed.set(domainBytes);
  framed[domainBytes.length] = 0;
  framed.set(valueBytes, domainBytes.length + 1);
  return framed;
}
