const sensitiveKey =
  /(password|passphrase|secret|token|api[-_]?key|authorization|credential|private[-_]?key|message[-_]?text|msisdn|phone|recipient|sender)/i;
const tokenLike = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){0,2}\b/g;
const phoneLike = /\+?[0-9][0-9\s()-]{7,}[0-9]/g;
const assignment =
  /(password|secret|token|api[-_]?key|authorization|credential)\s*[:=]\s*[^\s,;]+/gi;
export function redactText(value: string): string {
  return value
    .replace(assignment, '$1=[REDACTED]')
    .replace(tokenLike, '[REDACTED]')
    .replace(phoneLike, '[REDACTED]');
}
export function redactEvidence(
  values: ReadonlyArray<{
    source: string;
    observation: string;
    value?: number | string;
    unit?: string;
  }>,
) {
  return values.slice(0, 50).map((value) => ({
    source: redactText(value.source).slice(0, 80),
    observation: redactText(value.observation).slice(0, 500),
    ...(typeof value.value === 'number'
      ? { value: value.value }
      : typeof value.value === 'string'
        ? {
            value: sensitiveKey.test(value.source)
              ? '[REDACTED]'
              : redactText(value.value).slice(0, 120),
          }
        : {}),
    ...(value.unit ? { unit: redactText(value.unit).slice(0, 30) } : {}),
  }));
}
