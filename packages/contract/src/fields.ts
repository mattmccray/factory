// CLI `k=v` parsing. Typed keys are parsed strictly; everything else stays a string so values
// like `sha=3e45678` or `title=404` are never coerced.
const INT_KEYS = ['round', 'maxRound', 'k'];

export function parseFields(args: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq < 1) throw new Error(`bad field '${a}' (want key=value)`);
    const k = a.slice(0, eq);
    const v = a.slice(eq + 1);
    if (INT_KEYS.includes(k)) {
      if (!/^-?\d+$/.test(v)) throw new Error(`field '${k}' must be an integer, got '${v}'`);
      out[k] = Number(v);
    } else if (k === 'reviewers') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        throw new Error(`field 'reviewers' must be a JSON array`);
      }
      if (!Array.isArray(parsed)) throw new Error(`field 'reviewers' must be a JSON array`);
      out[k] = parsed;
    } else out[k] = v === 'null' ? null : v;
  }
  return out;
}
