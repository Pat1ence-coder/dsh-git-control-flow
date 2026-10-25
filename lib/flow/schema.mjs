/**
 * Schema adapter for the session-projection contract.
 *
 * `ctx.sessionProjections` declares `stateSchema` / `viewSchema` as Zod types,
 * but the runtime only ever calls `parse(value)` on them (verified against
 * `@deepseek-ai/dsh-session-projection`). This plugin has no dependencies, so
 * instead of pulling in `zod` it provides the exact subset the registry uses
 * and keeps the validation explicit.
 *
 * Trade-off, recorded in DSH-GIT-FLOW-DEVELOPMENT.md §9: if a future Harness
 * version starts reading Zod internals here, this adapter must be replaced by
 * a real `zod` schema.
 */

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} ValidationResult
 */

/**
 * Build one schema object from a validator.
 * @param {string} label - error prefix
 * @param {(value: unknown) => ValidationResult} validate
 * @returns {{ parse(value: unknown): unknown, safeParse(value: unknown): { success: true, data: unknown } | { success: false, error: { message: string } } }}
 */
export function defineSchema(label, validate) {
  const message = (reason) => `${label}: ${reason}`;
  return {
    parse(value) {
      const result = validate(value);
      if (!result.ok) throw new Error(message(result.reason));
      return value;
    },
    safeParse(value) {
      const result = validate(value);
      if (!result.ok) return { success: false, error: { message: message(result.reason) } };
      return { success: true, data: value };
    },
  };
}
