const freezeJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return value;
  Object.values(value).forEach(freezeJsonValue);
  return Object.freeze(value);
};

const assertNoEmbeddedBytes = (value: unknown, seen = new WeakSet<object>()): void => {
  if (
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob
  ) {
    throw new TypeError('Durable values must reference binary objects instead of embedding bytes.');
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.values(value).forEach(child => {
    assertNoEmbeddedBytes(child, seen);
  });
};

const assertNoEmbeddedDataUrls = (value: unknown): void => {
  if (typeof value === 'string') {
    if (/(?:^|[\s"'=(])data:[^,\s"']*,/iu.test(value)) {
      throw new TypeError(
        'Durable values must reference binary objects instead of embedding data URLs.'
      );
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  Object.values(value).forEach(assertNoEmbeddedDataUrls);
};

export const snapshotDurableJson = <Value>(value: Value): Value => {
  assertNoEmbeddedBytes(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Durable values must be JSON serializable.');
  const snapshot = JSON.parse(serialized) as Value;
  assertNoEmbeddedDataUrls(snapshot);
  return snapshot;
};

export const snapshotImmutableJson = <Value>(value: Value): Value =>
  freezeJsonValue(snapshotDurableJson(value)) as Value;
