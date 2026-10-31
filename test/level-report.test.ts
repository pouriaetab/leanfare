// 0.12, quality by level: the report's grades for each level the answers were handed off at, all levels together, the
// hand offs from before the levels, and how many answers graded partly or wrong were fixed before the app answered.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { db } from "../src/db";
import { levelLine } from "../src/mcp";
import { checkReport, report } from "../src/report";
import { ALL_TICKED, boot, reset } from "./app";
import { closeApp, openApp as open } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }

let minute = 0;
const hand = (f: Record<string, unknown>) => {
  const ts = new Date(Date.parse("2026-10-21T10:00:00Z") + minute++ * 60_000).toISOString();
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), task: "longer_query", kind: "read", effort: "low", model: "google/gemini-3.8-flash", cost: 0, files: 1, file_tokens: 100, answer_tokens: 10, status: "ok", chance: 0, app: "Claude", ...f };
  const keys = Object.keys(row);
  return Number(db.query(`INSERT INTO delegations(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[])).lastInsertRowid);
};
const day = () => checkReport(new URLSearchParams({ range: "custom", from: "2026-10-21T09:00:00Z", to: "2026-10-21T12:00:00Z" })) as any;

function seed() {
  minute = 0;
  hand({ level: 2, grade: "good" });
  hand({ level: 2, grade: "partly", fixed: "myself" }); // fixed by the app itself
  const w = hand({ level: 3, grade: "wrong", fixed: "leanfare" }); // fixed one tier up, the fix graded good
  hand({ level: 3, grade: "good", fix_of: w });
  const p = hand({ level: 3, grade: "partly", fixed: "leanfare" }); // asked one tier up, the fix still wrong
  hand({ level: 3, grade: "wrong", fix_of: p });
  hand({ level: 3, grade: "partly" }); // not fixed
  hand({ level: 5 }); // not graded yet
  hand({ level: null, grade: "good" }); // before the levels
}

test("each level's grades, the hand offs before the levels, all levels together, and fixed first", async () => {
  seed();
  const r = await report(day());
  const b = r.byLevel;
  expect(b.levels.map((x: any) => [x.level, x.parts, x.graded, x.good, x.partly, x.wrong, x.bad, x.fixed])).toEqual([
    [2, 2, 2, 1, 1, 0, 1, 1],
    [3, 5, 5, 1, 2, 2, 3, 1], // the fixes count as answers; fixed first counts the first answers only
    [5, 1, 0, 0, 0, 0, 0, 0],
  ]);
  expect(b.before).toMatchObject({ parts: 1, graded: 1, good: 1, goodShare: 1 });
  expect(b.all).toMatchObject({ parts: 9, graded: 8, good: 3, partly: 3, wrong: 2, bad: 4, fixed: 2 });
  expect(b.all.goodShare).toBeCloseTo(3 / 8, 12);
  expect(levelLine(b)).toBe("Quality by level: 2 (Light) 50% good of 2 graded, 1 of 1 fixed first; 3 (More) 20% good of 5 graded, 1 of 3 fixed first; 5 (All it can) 1 not graded yet; before levels 100% good of 1 graded; all levels 38% good of 8 graded, 2 of 4 fixed first.");
  expect(levelLine({ levels: [], before: null, all: { parts: 0 } })).toBe("");
});

test("Savings shows quality by level, with all levels set apart", async () => {
  seed();
  const doc = await open(url);
  doc.querySelector('.tabs button[data-tab="savings"]').click();
  await waitFor(() => [...doc.querySelectorAll("#reportCard .card h3")].some((x: any) => x.textContent === "Quality by level"));
  const card = [...doc.querySelectorAll(".card")].find((c: any) => c.querySelector("h3")?.textContent === "Quality by level") as any;
  expect(card).toBeTruthy();
  const rows = [...card.querySelectorAll(".rp-level")].map((x: any) => x.querySelector(".nm b").textContent);
  expect(rows).toEqual(["2 · Light", "3 · More", "5 · All it can", "Before levels", "All levels"]);
  const three = [...card.querySelectorAll(".rp-level")].find((x: any) => x.textContent.startsWith("3 · More")) as any;
  expect(three.textContent).toContain("20% good · 1 good · 2 partly · 2 wrong");
  expect(three.textContent).toContain("fixed first: 1 of 3");
  expect(card.querySelector(".rp-level.all").textContent).toContain("fixed first: 2 of 4");
}, 30000);
