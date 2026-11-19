/** fonts --measure measures only fonts that text uses; unexpected errors say they are Cadesa bugs. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatUnexpected, RunError } from "../src/diagnostics.js";
import { measureReport, type FontReport } from "../src/fonts.js";

describe("fonts --measure", () => {
  it("skips fonts no laid-out text is set in (no browser needed for them)", async () => {
    const unused = { family: "KaTeX_Main", stack: "KaTeX_Main", weights: [400], sizes: [], boxes: [], faces: [{ family: "KaTeX_Main", weight: "400", style: "normal", src: [{ url: "x.woff2", exists: false }] }], status: "file" } as unknown as FontReport;
    expect(await measureReport([unused])).toEqual([]);
  });
});

describe("unexpected errors", () => {
  it("say they are a Cadesa bug, with the stack only under CADESA_DEBUG", () => {
    const e = new RangeError("Invalid array length");
    const plain = formatUnexpected(e, false);
    expect(plain).toMatch(/^cadesa: Invalid array length\n {2}this is a Cadesa bug; please report it with the page/);
    expect(plain).toContain("CADESA_DEBUG=1");
    expect(plain).not.toMatch(/\n\s+at /);
    expect(formatUnexpected(e, true)).toMatch(/\n\s+at /);
  });

  it("aren't called a bug when a file is missing or the run can't go on", () => {
    let missing: unknown;
    try {
      readFileSync("test/does-not-exist.html");
    } catch (e) {
      missing = e;
    }
    expect(formatUnexpected(missing, false)).toBe("cadesa: no such file: test/does-not-exist.html\n");
    expect(formatUnexpected(new RunError("https://x.test/ returned HTTP 404 Not Found: nothing was captured"), false)).toBe("cadesa: https://x.test/ returned HTTP 404 Not Found: nothing was captured\n");
  });
});
