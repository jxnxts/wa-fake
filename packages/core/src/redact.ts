// Evidence is an allowlist, never a recursive copy of an HTTP body or headers.
const allowed = new Set([
  'method',
  'path',
  'status',
  'code',
  'message_id',
  'webhook_id',
  'attempt',
  'next_at',
  'field',
  'type',
  'count',
  'duration_ms',
]);
export function redactEvidence(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key, value]) =>
          allowed.has(key) &&
          (['number', 'boolean'].includes(typeof value) ||
            (typeof value === 'string' && value.length < 250)),
      )
      .map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value.replace(/EAA\w+|Bearer\s+\S+|wa-fake-(?:token|sim|secret)/gi, '[REDACTED]')
          : value,
      ]),
  );
}
