function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidJsonValue(): never {
  throw new TypeError("Canonical JSON input must be a finite, acyclic JSON data tree.");
}

function serializeCanonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidJsonValue();
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") return invalidJsonValue();
  if (ancestors.has(value)) return invalidJsonValue();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) invalidJsonValue();
      const canonical: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) invalidJsonValue();
        canonical.push(serializeCanonicalJson(descriptor.value, ancestors));
      }
      const extraKeys = Object.getOwnPropertyNames(value).filter((key) => {
        if (key === "length") return false;
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key;
      });
      if (extraKeys.length > 0) invalidJsonValue();
      return `[${canonical.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidJsonValue();
    if (Object.getOwnPropertySymbols(value).length > 0) invalidJsonValue();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const canonicalEntries = Object.entries(descriptors)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor)) invalidJsonValue();
        return `${JSON.stringify(key)}:${serializeCanonicalJson(
          descriptor.value,
          ancestors,
        )}`;
      });
    return `{${canonicalEntries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Validates and serializes a JSON data tree with recursively code-unit-sorted
 * object keys. Arrays retain their protocol-significant order. Unicode text is
 * not normalized; semantic schemas must normalize text before this boundary if
 * their protocol requires it.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeCanonicalJson(value, new WeakSet());
}
