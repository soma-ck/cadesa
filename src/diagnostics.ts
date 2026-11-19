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

/**
 * An error that isn't a diagnostic or a usage error. A file that can't be read and a RunError are
 * the user's to fix; anything else is a bug in Cadesa, said as such, with the stack when `debug`
 * (CADESA_DEBUG=1).
 */
export function formatUnexpected(e: unknown, debug = !!process.env.CADESA_DEBUG && process.env.CADESA_DEBUG !== "0"): string {
  const err = e instanceof Error ? e : new Error(String(e));
  const sys = err as Error & { code?: string; path?: string };
  if (sys.code && /^(ENOENT|EACCES|EISDIR|ENOTDIR|EPERM)$/.test(sys.code) && sys.path)
    return `cadesa: ${sys.code === "ENOENT" ? "no such file" : sys.code === "EISDIR" ? "a directory, not a file" : sys.code === "ENOTDIR" ? "not a directory" : "can't read"}: ${sys.path}\n`;
  if (err instanceof RunError) return `cadesa: ${err.message}\n`;
  return (
    `cadesa: ${err.message}\n` +
    `  this is a Cadesa bug; please report it with the page and its CSS: https://github.com/soma-ck/cadesa/issues\n` +
    (debug ? `${err.stack ?? ""}\n` : "  (run with CADESA_DEBUG=1 to see where it happened)\n")
  );
}

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
