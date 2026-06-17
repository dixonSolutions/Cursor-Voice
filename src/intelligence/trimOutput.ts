/**
 * Trim large tool payloads before returning them to Claude.
 */

export function trimForLlm(value: unknown, maxChars: number): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return truncateText(value, maxChars);
  }

  if (Array.isArray(value)) {
    return value.map((item) => trimForLlm(item, maxChars));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'progress' && Array.isArray(val) && val.length > 8) {
        out[key] = [
          ...val.slice(0, 3),
          { kind: 'trimmed', text: `… ${val.length - 5} more events …` },
          ...val.slice(-2),
        ];
        continue;
      }
      out[key] = trimForLlm(val, maxChars);
    }
    return out;
  }

  return value;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head - 24;
  return `${text.slice(0, head).trimEnd()}\n… [trimmed ${text.length - maxChars} chars] …\n${text.slice(-tail).trimStart()}`;
}
