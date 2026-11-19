export interface Diagnostic {
  severity: "error" | "warning";
  file: string;
  /** Dotted YAML path, e.g. `styles.settings-panel.layout.gap`. */
  path: string;
  line?: number;
  col?: number;
  message: string;
  expected?: string;
  got?: string;
  suggestion?: string;
}

export class CadesaError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n\n"));
  }
}

/**
 * A run that can't go on for a reason outside Cadesa (a page that returns 404, a login script
 * without the right export): reported as is, not as a Cadesa bug.
 */
export class RunError extends Error {}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line ? `${d.file}:${d.line}:${d.col}` : d.file;
  const lines = [`${where} ${d.severity}${d.path ? ` ${d.path}` : ""}: ${d.message}`];
  if (d.expected) lines.push(`  expected: ${d.expected}`);
  if (d.got !== undefined) lines.push(`  got: ${d.got}`);
  if (d.suggestion) lines.push(`  did you mean ${d.suggestion}?`);
  return lines.join("\n");
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function closest(word: string, options: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const o of options) {
    const s = levenshtein(word, o);
    if (s < bestScore) {
      best = o;
      bestScore = s;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(word.length / 3)) ? `"${best}"` : undefined;
}
