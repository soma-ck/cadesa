/** Field report on 0.1.19: icon contrast (WCAG 1.4.11), one entry per colour rule, the coverage line under --verify, capture --before. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isIconText } from "../src/check.js";
import { captureCmd, checkCmd, parseWidths } from "../src/commands.js";
import { launchChromium } from "../src/metrics.js";
import { formatCoverage } from "../src/report.js";

const run = () => checkCmd({ fixture: "fixtures/feedback/notice.html", css: "fixtures/feedback/notice.css", widths: parseWidths("400") });

describe("icons are held to 3:1", () => {
  it("recognises icon-font glyphs", () => {
    expect(isIconText("")).toBe(true);
    expect(isIconText("  ")).toBe(true);
    expect(isIconText("Job ")).toBe(false);
    expect(isIconText("")).toBe(false);
  });
  it("judges an icon against WCAG 1.4.11", () => {
    const r = run();
    expect(r.text).toMatch(/<span\.ico> icon #e0a800 on #fff3cd is 1\.94:1; WCAG 1\.4\.11 needs 3:1 for icons/);
  });
});

describe("contrast findings group by the rule that sets the colour", () => {
  it("lists the same grey on two backgrounds once, each element with its own ratio", () => {
    const t = run().text;
    expect(t).toContain("· on 3 elements");
    expect(t).toMatch(/"1".* · on #e9ecef is 2\.78:1/);
    expect(t).toMatch(/"2".* · on #ffffff is 2\.85:1/);
    expect(t).toMatch(/color: .*notice\.css:8 \.step/);
  });
});

describe("the coverage line after --verify", () => {
  it("says what Chromium agreed on instead of advising distrust", () => {
    const cov = { widths: 1, boxes: 396, exact: 0, approximate: 396, reasons: [] };
    const verify = { widths: [400], sampled: [], browser: "Chromium", boxes: { exact: 0, exactDiffer: 0, approximate: 396, approximateDiffer: 235, examples: [] } };
    const text = formatCoverage(cov, verify as never);
    expect(text).toContain("verified: Chromium agrees on 161 of 396 boxes");
    expect(text).not.toContain("treat what follows as leads");
  });
});

const browserOk = await launchChromium().then(
  async (b) => (await b.close(), true),
  () => false,
);

describe.skipIf(!browserOk)("capture --before", () => {
  it("captures the state a click opens", async () => {
    const out = mkdtempSync(join(tmpdir(), "cadesa-before-"));
    try {
      await captureCmd({ url: "fixtures/feedback/modal.html", out, before: ["click: text=Full log", "wait: .modal.show"] });
      expect(readFileSync(join(out, "page.html"), "utf8")).toMatch(/class="modal show"/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  it("names a step that fails", async () => {
    const out = mkdtempSync(join(tmpdir(), "cadesa-before-"));
    try {
      await expect(captureCmd({ url: "fixtures/feedback/modal.html", out, before: ["click: text=Nope"] }).catch((e) => Promise.reject(e))).rejects.toThrow();
      await expect(captureCmd({ url: "fixtures/feedback/modal.html", out, before: ["tap: x"] })).rejects.toThrow(/expected click:/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
