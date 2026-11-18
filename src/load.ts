import { readFileSync } from "node:fs";
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";
import type { Diagnostic } from "./diagnostics.js";

export type PathSeg = string | number;

export interface Source {
  file: string;
  text: string;
  data: unknown;
  /** Locate a YAML path. `key: true` points at the mapping key instead of its value. */
  locate(path: PathSeg[], opts?: { key?: boolean }): { line: number; col: number } | undefined;
  parseErrors: Diagnostic[];
}

export function loadSourceFile(file: string): Source {
  return loadSource(file, readFileSync(file, "utf8"));
}

export function loadSource(file: string, text: string): Source {
  const lineCounter = new LineCounter();
  const doc: Document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  const pos = (offset: number) => {
    const p = lineCounter.linePos(offset);
    return { line: p.line, col: p.col };
  };

  const parseErrors: Diagnostic[] = [...doc.errors, ...doc.warnings].map((e) => ({
    severity: "error",
    file,
    path: "",
    ...pos(e.pos[0]),
    message: `YAML: ${e.message.split("\n")[0]}`,
  }));

  function locate(path: PathSeg[], opts: { key?: boolean } = {}) {
    if (opts.key && path.length > 0) {
      const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
      if (isMap(parent)) {
        const last = path[path.length - 1];
        const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === last);
        if (pair && isScalar(pair.key) && pair.key.range) return pos(pair.key.range[0]);
      }
    }
    const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
    const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
    if (range) return pos(range[0]);
    // Fall back to the nearest ancestor that exists in the file.
    if (path.length > 0) return locate(path.slice(0, -1), opts);
    return undefined;
  }

  return { file, text, data: doc.toJS(), locate, parseErrors };
}
