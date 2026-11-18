/**
 * check --verify and capture, against local fixtures in Chromium. Skipped when Playwright or a
 * Chrome/Chromium isn't available ($CADESA_CHROME, a system install, or Playwright's own).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "../src/check.js";
import { captureCmd, checkCmd, checkVerifyCmd, parseWidths } from "../src/commands.js";
import { launchChromium } from "../src/metrics.js";

const browserOk = await launchChromium().then(
  async (b) => (await b.close(), true),
  () => false,
);
const tmp = mkdtempSync(join(tmpdir(), "cadesa-browser-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const verified = async (fixture: string, css: string, widths: string) => {
  const r = await checkVerifyCmd({ fixture, css, widths: parseWidths(widths) });
  return { r, f: (r.data as { findings: Finding[] }).findings };
};

describe.skipIf(!browserOk)("check --verify", () => {
  it("confirms what Chromium shows and marks what it doesn't as not reproduced", async () => {
    const { r, f } = await verified("fixtures/verify/page.html", "fixtures/verify/page.css", "400,800");
    const by = (cls: string) => f.filter((x) => x.element?.classes.includes(cls));
    expect(by("close").map((x) => x.verified)).toEqual([
      { status: "confirmed", detail: "20×20px" },
      { status: "confirmed", detail: "20×20px" },
    ]);
    // Drawn at scale(3): 60×60 in Chromium, though 20×20 in the layout.
    expect(by("zoomed")[0].verified).toEqual({ status: "not reproduced", detail: "60×60px" });
    expect(by("note")[0].verified).toMatchObject({ status: "confirmed", detail: "text #999999 on #ffffff is 2.85:1; WCAG AA needs 4.5:1" });
    expect(by("box")[0].verified).toMatchObject({ status: "confirmed", detail: "overflows by 100px" });
    expect(r.text).toContain("chromium: confirmed at 400, 800px (20×20px)");
    expect(r.text).toMatch(/not reproduced in Chromium[^\n]*\n○ \[tap-target\] <button\.zoomed>/);
    expect(r.text).toContain("2 errors, 1 warning, 1 not reproduced in Chromium");
    const v = (r.data as { verify: { widths: number[]; boxes: { exact: number } } }).verify;
    expect(v.widths).toEqual([400, 800]);
    expect(v.boxes.exact).toBeGreaterThan(0);
  });

  it("confirms findings on an approximate page, and samples widths without findings", async () => {
    const plain = checkCmd({ fixture: "fixtures/bootstrap/orders.html", css: "fixtures/bootstrap/bootstrap.css,fixtures/bootstrap/app.css", widths: parseWidths("390,1280") });
    // Contrast on these buttons no longer depends on their (approximate) position: already conclusive.
    expect((plain.data as { findings: Finding[] }).findings.every((x) => !x.inconclusive)).toBe(true);
    const { r, f } = await verified("fixtures/bootstrap/orders.html", "fixtures/bootstrap/bootstrap.css,fixtures/bootstrap/app.css", "390,1280");
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.verified!.status).toBe("confirmed");
      expect(x.inconclusive).toBeFalsy();
      expect(x.severity).toBe("error");
    }
    expect(r.text).not.toContain("inconclusive (");
    expect(r.ok).toBe(false);
  });

  it("measures clipped text in Chromium (scrollWidth past clientWidth)", async () => {
    const { f } = await verified("fixtures/css/overflow.html", "fixtures/css/overflow.css", "375,800");
    const clipped = f.filter((x) => x.check === "clipped");
    expect(clipped.map((x) => [x.width, x.verified?.status])).toEqual([
      [375, "confirmed"],
      [375, "confirmed"],
    ]);
    expect(clipped[0].verified!.detail).toMatch(/^\d+px of its text is cut off$/);
  });

  it("loads widths without findings too", async () => {
    const { r } = await verified("fixtures/bootstrap/planning.html", "fixtures/bootstrap/bootstrap.css,fixtures/bootstrap/app.css", "320-1440/20");
    const v = (r.data as { verify: { widths: number[]; sampled: number[] } }).verify;
    expect(v.sampled.length).toBe(6);
    expect(r.text).toMatch(/verified in Chromium .* at 6 widths \(0 with findings, 6 without\)/);
  });
});

describe.skipIf(!browserOk)("capture", () => {
  it("saves the rendered DOM, every stylesheet in cascade order and the fonts, without scripts or secrets", async () => {
    const out = join(tmp, "app");
    const r = await captureCmd({ url: "fixtures/capture/app.html", out, wait: ".card" });
    const page = readFileSync(join(out, "page.html"), "utf8");
    // The DOM the script rendered, with nothing that runs or holds a secret.
    expect(page).toContain('<h1 class="title">Orders</h1>');
    expect(page).not.toMatch(/<script|hunter2|secret-token|value="abc"/);
    expect(page).toMatch(/<link rel="stylesheet" href="css\/01-base.css">\n<link rel="stylesheet" href="css\/02-style-1.css">\n<link rel="stylesheet" href="css\/03-style-2.css">\n<\/head>/);
    expect(readdirSync(join(out, "css"))).toEqual(["01-base.css", "02-style-1.css", "03-style-2.css"]);
    // @import inlined where it was; the font url points at the saved file; the empty custom property kept.
    const base = readFileSync(join(out, "css", "01-base.css"), "utf8");
    expect(base).toMatch(/^:root \{\n {2}--ink: #1f2328;/);
    expect(base).toContain("--empty: ;");
    expect(base).not.toContain("@import");
    expect(base).toContain('src: url("../fonts/InterVariable-latin.woff2") format("woff2")');
    expect(readFileSync(join(out, "fonts", "InterVariable-latin.woff2"))).toEqual(readFileSync("fonts/InterVariable-latin.woff2"));
    // CSS-in-JS rules inserted through the CSSOM (the <style> element has no text).
    expect(readFileSync(join(out, "css", "03-style-2.css"), "utf8")).toContain(".muted { color: rgb(154, 160, 166); margin: 0px 0px 8px; }");
    const data = r.data as { stylesheets: { via: string }[]; command: string };
    expect(data.stylesheets.map((s) => s.via)).toEqual(["network", "text", "cssom"]);
    expect(r.text).toContain(`check it with:\n  ${data.command}`);

    // The printed command works, and finds what is in the page.
    const [, pagePath, , css] = data.command.split(" ").slice(1);
    const c = checkCmd({ fixture: pagePath, css, widths: [400] });
    const found = (c.data as { findings: Finding[] }).findings;
    expect(found.find((x) => x.check === "contrast")!.element).toMatchObject({ tag: "p", classes: ["muted"] });
    expect(found.find((x) => x.element?.classes.includes("icon-btn"))!.source![0].rules[0]).toMatchObject({ selector: ".icon-btn", line: 2, file: expect.stringMatching(/03-style-2\.css$/) });
  });

  it("runs the login script before loading the page", async () => {
    const login = join(tmp, "login.mjs");
    writeFileSync(login, `export default async (page) => {
  await page.context().addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.body.setAttribute("data-user", "signed-in")));
};\n`);
    const out = join(tmp, "login");
    await captureCmd({ url: "fixtures/capture/app.html", out, loginScript: login });
    expect(readFileSync(join(out, "page.html"), "utf8")).toContain('<body data-user="signed-in">');
    expect(existsSync(join(out, "cookies.json"))).toBe(false);
  });

  it("says what a login script must export", async () => {
    const bad = join(tmp, "bad.mjs");
    writeFileSync(bad, "export const x = 1;\n");
    await expect(captureCmd({ url: "fixtures/capture/app.html", out: join(tmp, "bad"), loginScript: bad })).rejects.toThrow(/must export a function: export default async \(page\)/);
  });
});
