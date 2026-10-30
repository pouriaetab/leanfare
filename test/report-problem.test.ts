// Report a problem (Settings, 0.11.3): a link to the bug report form on GitHub with the version and the system's name
// filled in (the form's text fields, by their ids). Nothing is sent: the person reads the form and sends it there.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION } from "../src/config";
import { boot, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset(); });
afterEach(closeApp);
const SYSTEM = ({ darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<string, string>)[process.platform] ?? process.platform;

test("the state says the system's name only, and Settings links to the bug form with it and the version", async () => {
  const st = (await ui(url, "/api/state")).json;
  expect([st.version, st.system]).toEqual([VERSION, SYSTEM]);
  const doc = await openApp(url);
  doc.querySelector('.tabs button[data-tab="settings"]').click();
  for (let i = 0; i < 160 && !doc.querySelector("#reportProblem"); i++) await Bun.sleep(50);
  const a = doc.querySelector("#reportProblem");
  expect(a.textContent).toBe("Report a problem ↗");
  expect([a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
  const link = new URL(a.getAttribute("href"));
  expect(`${link.origin}${link.pathname}`).toBe("https://github.com/pouriaetab/leanfare/issues/new");
  expect(Object.fromEntries(link.searchParams)).toEqual({ template: "bug_report.yml", version: VERSION, system: SYSTEM });
}, 20000);

test("the form the link opens has those fields, by those ids", async () => {
  const form = await Bun.file(join(import.meta.dir, "..", ".github", "ISSUE_TEMPLATE", "bug_report.yml")).text(); // the tests run in a folder of their own
  for (const id of ["version", "system"]) expect(form).toMatch(new RegExp(`\\n  - type: input\\n    id: ${id}\\n`));
});
