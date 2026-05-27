/** Promise-based timeout helper used by polling loops. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Read nested token counters from multiple possible provider field names. */
export function tokenCount(source: unknown, ...paths: string[]): number {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, source);
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

/**
 * Cheap token estimate for live `running_stats` before Hermes sends final usage.
 *
 * The final `result` event always overwrites these counters with provider usage
 * when Hermes includes it. During streaming, this keeps the Even App's progress
 * UI moving without depending on tokenizer packages or model-specific encoders.
 */
export function approximateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

/** Clamp diagnostic text so accidental huge tool payloads do not flood the app. */
export function preview(value: unknown, max = 500): string {
  return String(value ?? "").slice(0, max);
}
