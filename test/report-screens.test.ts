// The report at the top of the Savings tab (report.ts, ui/app.js): four tiles, tokens over time, work by model,
// quality by kind, each prompt with its parts and its app's own row, a span or a filter asked again, and the CSV.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "../src/db";
import { forgetLogs } from "../src/plans";
import { boot, outgoing, reset } from "./app";
import { closeApp, openApp as open, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.querySelector("#reportCard")?.textContent ?? "");
let n = 0;
function session() {
  const path = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-Users-you-app", "s-ui.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const rows = [
    { type: "user", timestamp: "2026-10-20T10:00:00Z", cwd: "/Users/you/app", message: { role: "user", content: "x".repeat(400) } },
    { type: "assistant", timestamp: "2026-10-20T10:00:30Z", requestId: `r${++n}`, message: { id: `m${n}`, model: "claude-opus-5-5", role: "assistant", usage: { input_tokens: 100, cache_creation_input_tokens: 1900, cache_read_input_tokens: 40000, output_tokens: 1000 } } },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  forgetLogs();
}
const hand = (ts: string, f: Record<string, unknown>) => {
  const row = { ts, month: ts.slice(0, 7), day: ts.slice(0, 10), task: "longer_query", kind: "read", effort: "low", model: "google/gemini-3.8-flash", cost: 0, files: 1, file_tokens: 0, answer_tokens: 0, status: "ok", chance: 0, ...f };
  const keys = Object.keys(row);
  db.query(`INSERT INTO delegations(${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
};
async function goReport(doc: any) {
  doc.querySelector('.tabs button[data-tab="savings"]').click();
  await waitFor(() => !!doc.querySelector("#reportCard .rp-tiles"));
}
beforeEach(async () => {
  rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
  forgetLogs();
  await reset();
  session();
  hand("2026-10-20T10:05:00Z", { app: "Claude Code", app_model: "claude-opus-5-5", file_tokens: 30000, answer_tokens: 500, grade: "good", ms: 6000 });
  hand("2026-10-21T09:00:00Z", { app: "Claude", app_model: "claude-opus-5-5", kind: "write", model: "deepseek/deepseek-v4-flash", cost: 0.003, file_tokens: 10000, answer_tokens: 900, verdict: "fail", checker: "xai/grok-4.20-beta" });
});

describe("the report", () => {
  test("four tiles (both sides), tokens over time, work by model, quality by kind and the prompts", async () => {
    const doc = await open(url);
    await goReport(doc);
    const tiles = [...doc.querySelectorAll("#reportCard .rp-tile")].map((t: any) => t.textContent);
    const tips = [...doc.querySelectorAll("#reportCard .rp-tile")].map((t: any) => t.title);
    // Saved, an estimate: Claude alone (30.5k and 10.9k: the files read, the answers written), less what handing them off
    // cost it (the tasks and receipts at a typical size before 0.10, and the answers read back: 0.7k and 1.1k). Each tile
    // shows its number and one short line; the whole of it is on hover (0.13.12).
    expect(tiles[0]).toBe("Saved for Claude estimate≈ 40krange 27k to 54k");
    expect(tips[0]).toBe("Claude alone ≈ 41k, minus the hand offs' own cost ≈ 2k (the tasks, and the answers read back). Range 27k to 54k.");
    expect(tiles[1]).toBe("Outside models used not knownNot measured yet$0.0030 · 50% free");
    expect(tips[1]).toBe("$0.0030, 50% of parts free · 2 older parts not measured");
    expect(tiles[2]).toBe("Claude's own use measured3k new tokens40k more from the cache");
    expect(tips[2]).toBe("Claude: not known · Claude Code, from its own files · 40k more read again from the cache");
    expect(tiles[3]).toBe("Quality, three waysOutside answers50 / 100 12 to 88Togethernot gradedClaude alonenot known");
    expect(tips[3]).toBe("Scores out of 100 (good 1, partly half, wrong 0), with their 90% range. 2 outside answers graded, 0 prompts graded together, 0 sampled runs of Claude alone");
    expect(doc.querySelectorAll("#reportCard .rp-chart path.l1, #reportCard .rp-chart path.l2")).toHaveLength(2);
    expect([...doc.querySelectorAll("#reportCard .rp-bar .nm span")].map((e: any) => e.textContent)).toEqual(["Gemini 3.8 Flash", "DeepSeek V4 Flash"]);
    expect([...doc.querySelectorAll("#reportCard .rp-kind .nm b")].map((e: any) => e.textContent)).toEqual(["Reading", "Drafting"]);
    // 0.15: one table; the prompt's model, its own tokens, Claude's helpers and the outside models in columns of their own.
    expect([...doc.querySelectorAll("#reportCard .rp-prompts thead th")].map((th: any) => th.textContent))
      .toEqual(["PRM", "When", "App", "Main model", "Main tokens", "Claude helpers", "Helper tokens", "Outside models", "Outside tokens", "Kinds", "Helpers total", "Outside total", "Cost", "Saved", "Grade"]);
    const rows = [...doc.querySelectorAll("#reportCard tr.pr")].map((r: any) => [...r.querySelectorAll("td")].map((td: any) => td.textContent.trim()));
    expect(rows.map((r) => r.filter((_, i) => i !== 1))).toEqual([
      ["▸PRM-2", "Claude", "Claude Opus 5.5", "not known", "—", "—", "DeepSeek V4 Flash", "not measured", "drafting", "—", "not measured", "$0.0030", "≈ 10k", "× wrong"],
      ["▸PRM-1", "Claude Code", "Claude Opus 5.5", "2k new, 40k cached, 1k written", "—", "—", "Gemini 3.8 Flash", "not measured", "reading", "—", "not measured", "$0", "≈ 30k", "✓ good"],
    ]);
    // A cell's second line is on hover.
    expect([...doc.querySelectorAll("#reportCard tr.pr")].map((r: any) => r.querySelector("td[data-col='saved']").title)).toEqual(["range 6k to 15k", "range 21k to 40k"]);
    expect(doc.querySelector("#reportCard tr.pr td[data-col='main']").title).toBe("Its effort: not said");
    expect(bad(doc)).toBe(false);
  });

  test("a prompt opens to its own rows in the same table: its main model, then each outside model by kind, every column in line", async () => {
    const doc = await open(url);
    await goReport(doc);
    ([...doc.querySelectorAll("#reportCard tr.pr")] as any[])[1].click();
    await waitFor(() => doc.querySelectorAll("#reportCard tr.part").length === 3);
    const head = [...doc.querySelectorAll("#reportCard .rp-prompts thead th")].map((th: any) => th.dataset.col);
    // Every row has a cell for every column, in the same order: what opens stays in line with the headers.
    for (const tr of doc.querySelectorAll("#reportCard tbody tr:not(.own)") as any) expect([...tr.querySelectorAll("td")].map((td: any) => td.dataset.col)).toEqual(head);
    const [main, outside] = [...doc.querySelectorAll("#reportCard tr.part")] as any[];
    const cell = (tr: any, col: string) => tr.querySelector(`td[data-col='${col}']`).textContent;
    expect(main.classList.contains("main")).toBe(true);
    expect([cell(main, "main"), cell(main, "mainTok"), cell(main, "outside"), cell(main, "prm")]).toEqual(["Claude Opus 5.5", "2k new, 40k cached, 1k written", "", ""]);
    expect([cell(outside, "prm"), cell(outside, "outside"), cell(outside, "kinds"), cell(outside, "cost"), cell(outside, "saved"), cell(outside, "grade"), cell(outside, "main")])
      .toEqual(["PRM-1.1", "Gemini 3.8 Flashfree", "reading", "$0", "≈ 30k", "✓ good", ""]);
    // The whole result, graded here: kept with the prompt's last part, and shown on the prompt.
    const own = doc.querySelector("#reportCard tr.part.own");
    expect(own.textContent).toBe("The whole result, Claude Code and the hand offs together: ✓ good~ partly× wrong");
    expect(own.querySelector("td").getAttribute("colspan")).toBe(String(head.length));
    ([...own.querySelectorAll("button")] as any[]).find((b) => b.textContent === "~ partly").click();
    await waitFor(() => (db.query("SELECT together FROM delegations WHERE app = 'Claude Code'").get() as any)?.together === "partly");
    expect((db.query("SELECT together, together_by FROM delegations WHERE app = 'Claude Code'").get() as any)).toEqual({ together: "partly", together_by: "you" });
    await waitFor(() => doc.querySelector("#reportCard .rp-tile:nth-child(4)")?.title.includes("1 prompt graded together"));
    expect(doc.querySelector("#reportCard .rp-tile:nth-child(4)").title).toContain("1 prompt graded together");
  });

  test("By model: a row for each prompt's model and kind, the prompt's id, time and app on each; the choice is kept", async () => {
    const doc = await open(url);
    await goReport(doc);
    ([...doc.querySelectorAll("#reportCard .rp-tbar .seg button")] as any[]).find((b) => b.textContent === "By model").click();
    await waitFor(() => !!doc.querySelector("#reportCard table.flat"));
    const rows = [...doc.querySelectorAll("#reportCard tbody tr")].map((r: any) => [r.className, ...["prm", "app", "main", "outside"].map((c) => r.querySelector(`td[data-col='${c}']`).textContent)]);
    expect(rows).toEqual([
      ["part main", "PRM-2", "Claude", "Claude Opus 5.5", ""],
      ["part outside", "PRM-2", "Claude", "", "DeepSeek V4 Flashpaid"],
      ["part main", "PRM-1", "Claude Code", "Claude Opus 5.5", ""],
      ["part outside", "PRM-1", "Claude Code", "", "Gemini 3.8 Flashfree"],
    ]);
    expect(doc.querySelector("#reportCard .rp-pager").textContent).toContain("1 to 4 of 4 rows");
    expect(win.localStorage.getItem("leanfare.report:rows")).toBe('"model"');
  });

  test("columns hide and move from the Columns menu, or by dragging a header; rows per page and the pages", async () => {
    // Twelve more prompts, 20 minutes apart (more than the 10 that join hand offs into one): fourteen in all.
    for (let i = 0; i < 12; i++) hand(new Date(Date.parse("2026-10-21T00:00:00Z") + i * 20 * 60_000).toISOString(), { app: "Claude", app_model: "claude-opus-5-5", file_tokens: 1000 + i });
    const doc = await open(url);
    await goReport(doc);
    const heads = () => [...doc.querySelectorAll("#reportCard .rp-prompts thead th")].map((th: any) => th.dataset.col);
    const button = (text: string) => ([...doc.querySelectorAll("#reportCard button")] as any[]).find((b) => b.textContent === text);
    button("Columns").click();
    await waitFor(() => !!doc.querySelector("#reportCard .rp-colmenu"));
    const box = (label: string) => doc.querySelector(`#reportCard .rp-colmenu input[aria-label="${label}"]`);
    box("Show Saved").click();
    await waitFor(() => !heads().includes("saved"));
    expect(heads()).not.toContain("saved");
    box("Show Together").click();
    await waitFor(() => heads().includes("together"));
    doc.querySelector(`#reportCard .rp-colmenu button[aria-label="Move Cost left"]`).click();
    await waitFor(() => heads().indexOf("cost") === heads().indexOf("outsideTotal") - 1);
    expect(heads().slice(10, 13)).toEqual(["helperTotal", "cost", "outsideTotal"]);
    expect(JSON.parse(win.localStorage.getItem("leanfare.report:cols")).hidden).toEqual(["alone", "saved"]);
    // Drag Grade onto App: it moves there.
    const th = (col: string) => doc.querySelector(`#reportCard .rp-prompts thead th[data-col='${col}']`);
    const drag = (type: string, el: any) => { const e = new win.Event(type, { bubbles: true, cancelable: true }); (e as any).dataTransfer = { data: {} as any, setData(k: string, v: string) { this.data[k] = v; }, getData(k: string) { return this.data[k]; } }; return e; };
    const start = drag("dragstart", th("grade")); th("grade").dispatchEvent(start);
    const drop = drag("drop", th("app")); drop.dataTransfer = start.dataTransfer; th("app").dispatchEvent(drop);
    await waitFor(() => heads()[2] === "grade");
    expect(heads().slice(0, 4)).toEqual(["prm", "when", "grade", "app"]);
    button("As at first").click();
    await waitFor(() => heads()[2] === "app" && heads().includes("saved"));
    expect(heads()).toEqual(["prm", "when", "app", "main", "mainTok", "helpers", "helperTok", "outside", "outsideTok", "kinds", "helperTotal", "outsideTotal", "cost", "saved", "grade"]);
    // Rows per page: 15 at first, 10 shows two pages.
    expect(doc.querySelectorAll("#reportCard tr.pr").length).toBe(14);
    const size = doc.querySelector("#reportCard select[aria-label='Rows per page']");
    size.value = "10"; size.dispatchEvent(new win.Event("change"));
    await waitFor(() => doc.querySelectorAll("#reportCard tr.pr").length === 10);
    expect(doc.querySelector("#reportCard .rp-page").textContent).toBe("Page 1 of 2");
    doc.querySelector("#reportCard button[aria-label='Next page']").click();
    await waitFor(() => doc.querySelectorAll("#reportCard tr.pr").length === 4);
    expect(doc.querySelector("#reportCard .rp-pager").textContent).toContain("11 to 14 of 14 prompts");
    expect(doc.querySelector("#reportCard button[aria-label='Next page']").hasAttribute("disabled")).toBe(true);
    expect(win.localStorage.getItem("leanfare.report:size")).toBe("10");
    expect(bad(doc)).toBe(false);
  });

  test("a span or a filter is asked again, and the CSV holds the prompts and their parts", async () => {
    const doc = await open(url);
    await goReport(doc);
    doc.querySelector("#reportCard .rp-when").click();
    await waitFor(() => !!doc.querySelector("#reportCard .rp-cal"));
    ([...doc.querySelectorAll("#reportCard .rp-cal .rp-quick button")] as any[]).find((b) => b.textContent === "Today").click();
    await waitFor(() => outgoing.some((u) => u.includes("/api/report?range=today")));
    expect(doc.querySelector("#reportCard .rp-when").textContent).toBe("Today ▾");
    await waitFor(() => doc.querySelectorAll("#reportCard tr.pr").length === 1); // yesterday's Claude Code prompt is out
    const apps = doc.querySelector("#reportCard select[aria-label='All apps']");
    apps.value = "Claude"; apps.dispatchEvent(new win.Event("change"));
    await waitFor(() => outgoing.some((u) => u.includes("range=today&app=Claude")));
    const saved: any[] = [];
    win.webkit = { messageHandlers: { leanfareSave: { postMessage: (m: any) => saved.push(m) } } };
    await waitFor(() => !!([...doc.querySelectorAll("#reportCard button")] as any[]).find((b) => b.textContent === "Export CSV"));
    ([...doc.querySelectorAll("#reportCard button")] as any[]).find((b) => b.textContent === "Export CSV").click();
    expect(saved[0].name).toMatch(/^leanfare-report-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = saved[0].text.trim().split("\n");
    expect(lines[0]).toStartWith("prompt_id,time,app,thread,project,main_model,plan,prompt_tokens");
    expect(lines.slice(1).map((l: string) => l.split(",").slice(0, 3).filter((_, i) => i !== 1))).toEqual([["PRM-2", "Claude"], ["PRM-2", "Claude"]]); // the prompt, then its part
    expect(lines[2]).toMatch(/,PRM-2\.1,\d+,write,/); // the part's id and its hand off number
    expect(lines[2]).toContain("DeepSeek V4 Flash,paid,10000,900");
  });

  test("the calendar: a click on a day then Show this day, or a click on a range's first day and its last; Esc closes it", async () => {
    const doc = await open(url);
    await goReport(doc);
    const open1 = async () => { doc.querySelector("#reportCard .rp-when").click(); await waitFor(() => !!doc.querySelector("#reportCard .rp-cal")); };
    await open1();
    expect(doc.querySelector("#reportCard .rp-month b").textContent).toBe("October 2026");
    const day = (label: string) => doc.querySelector(`#reportCard .rp-cal .rp-day[aria-label="${label}"]`);
    expect(day("Oct 21, 2026").classList.contains("today")).toBe(true);
    day("Oct 20, 2026").click();
    await waitFor(() => !!day("Oct 20, 2026")?.classList.contains("edge"));
    expect(doc.querySelector("#reportCard .rp-cal .rp-pop-foot").textContent).toContain("From Oct 20: click the last day, or show this day alone.");
    ([...doc.querySelectorAll("#reportCard .rp-cal button")] as any[]).find((b) => b.textContent === "Show this day").click();
    const one = new URLSearchParams({ range: "custom", from: new Date(2026, 9, 20).toISOString(), to: new Date(2026, 9, 21).toISOString() }).toString();
    await waitFor(() => outgoing.some((u) => u.endsWith(`/api/report?${one}`)));
    expect(doc.querySelector("#reportCard .rp-when").textContent).toBe("Oct 20 ▾");
    await waitFor(() => doc.querySelectorAll("#reportCard tr.pr").length === 1);
    expect([...doc.querySelectorAll("#reportCard tr.pr td[data-col='app']")].map((td: any) => td.textContent)).toEqual(["Claude Code"]); // the prompt of the 20th
    // A range, picked last day first: the same as first day first; a month back and forth.
    await open1();
    doc.querySelector("#reportCard .rp-cal button[aria-label='Previous month']").click();
    await waitFor(() => doc.querySelector("#reportCard .rp-month b")?.textContent === "September 2026");
    doc.querySelector("#reportCard .rp-cal button[aria-label='Next month']").click();
    await waitFor(() => doc.querySelector("#reportCard .rp-month b")?.textContent === "October 2026");
    day("Oct 21, 2026").click();
    await waitFor(() => !!doc.querySelector("#reportCard .rp-cal .rp-pop-foot")?.textContent.includes("From Oct 21"));
    day("Oct 19, 2026").click();
    const range = new URLSearchParams({ range: "custom", from: new Date(2026, 9, 19).toISOString(), to: new Date(2026, 9, 22).toISOString() }).toString();
    await waitFor(() => outgoing.some((u) => u.endsWith(`/api/report?${range}`)));
    expect(doc.querySelector("#reportCard .rp-when").textContent).toBe("Oct 19 to Oct 21 ▾");
    await waitFor(() => doc.querySelectorAll("#reportCard tr.pr").length === 2);
    // Opened again, the range shows; Esc closes it and changes nothing.
    await open1();
    expect(["Oct 19, 2026", "Oct 20, 2026", "Oct 21, 2026"].every((l) => day(l).classList.contains("in"))).toBe(true);
    expect(day("Oct 22, 2026").classList.contains("in")).toBe(false);
    doc.querySelector("#reportCard .rp-cal").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !doc.querySelector("#reportCard .rp-cal"));
    expect(doc.querySelector("#reportCard .rp-cal")).toBe(null);
    // Yesterday, from the quick picks.
    await open1();
    ([...doc.querySelectorAll("#reportCard .rp-cal .rp-quick button")] as any[]).find((b) => b.textContent === "Yesterday").click();
    await waitFor(() => doc.querySelector("#reportCard .rp-when")?.textContent === "Oct 20 ▾");
    expect(doc.querySelector("#reportCard .rp-when").textContent).toBe("Oct 20 ▾");
  });

  test("the report tool's link (#report) opens Savings at the report, whatever screen was open last", async () => {
    const doc = await open(url, { screen: "plan", hash: "#report" });
    await waitFor(() => !!doc.querySelector("#reportCard .rp-tiles"));
    expect(doc.querySelector('.tabs button[data-tab="savings"]').getAttribute("aria-selected")).toBe("true");
    expect(doc.querySelector("#reportCard .rp-tile").textContent).toContain("Saved for Claude");
  });

  test("a project's name that starts like a formula stays text in the CSV", async () => {
    const path = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-Users-you-x", "s-csv.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "user", timestamp: "2026-10-21T10:00:00Z", cwd: "/Users/you/=2+5", message: { role: "user", content: "hello there" } }) + "\n");
    forgetLogs();
    const doc = await open(url);
    await goReport(doc);
    const saved: any[] = [];
    win.webkit = { messageHandlers: { leanfareSave: { postMessage: (m: any) => saved.push(m) } } };
    ([...doc.querySelectorAll("#reportCard button")] as any[]).find((b) => b.textContent === "Export CSV").click();
    expect(saved[0].text).toContain(",s-csv,'=2+5,");
  });

  test("with nothing in the span, it says so", async () => {
    db.exec("DELETE FROM delegations");
    rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true }); forgetLogs();
    const doc = await open(url);
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#reportCard")?.textContent.includes("Nothing in this span yet"));
    expect(doc.querySelector("#reportCard").textContent).toContain("Nothing in this span yet.");
  });
  test("a prompt's day and time are written apart, so every computer shows the same \"Oct 20, 10:05 AM\"", () => {
    // Asked for the day and the time in one call, some versions of the system's date library write "Oct 20 at
    // 10:05 AM" and others "Oct 20, 10:05 AM", so the same page read differently on two computers.
    const together = /toLocaleString\(undefined, \{[^}]*\bmonth\b[^}]*\bhour\b|toLocaleString\(undefined, \{[^}]*\bhour\b[^}]*\bmonth\b/;
    for (const f of ["ui/app.js", "src/reportapp.ts"]) expect(readFileSync(join(import.meta.dir, "..", f), "utf8")).not.toMatch(together);
  });
});

// 0.15.2: the report was read once, so a prompt that came in later showed only on the next load (he saw the last one at
// 12:25 PM well after). Refresh reads it again, and says when it was read.
describe("the report, read again", () => {
  test("Refresh shows a prompt that came in after the report was read, and the time it was read", async () => {
    const doc = await open(url);
    await goReport(doc);
    doc.querySelector('#reportCard .rp-views [role="tab"]:nth-child(2)').click(); // Prompts
    await waitFor(() => !!doc.querySelector("#reportCard .rp-table.pt"));
    const table = () => doc.querySelector("#reportCard .rp-table.pt")?.textContent ?? "";
    expect(doc.querySelector("#reportCard .rp-updated").textContent).toStartWith("Updated ");
    expect(table()).not.toContain("11:55");
    // Two Cowork turns come in after the report was read: the second is a prompt of its own.
    db.query("INSERT INTO app_turns(ts, day, app, model, input, cached, output) VALUES ('2026-10-21T11:50:00Z', '2026-10-21', 'Claude', 'claude-opus-5-5', 300, 9000, 200), ('2026-10-21T11:55:00Z', '2026-10-21', 'Claude', 'claude-opus-5-5', 400, 9500, 250)").run();
    await Bun.sleep(300);
    expect(table()).not.toContain("11:55"); // nothing reads it again by itself within the minute
    const refresh = [...doc.querySelectorAll("#reportCard .rp-views button")].find((b: any) => b.textContent === "Refresh") as any;
    expect(refresh.title).toBe("Read the prompts again, with what came in since");
    refresh.click();
    await waitFor(() => table().includes("11:55"));
    expect(table()).toContain("11:55");
    expect(bad(doc)).toBe(false);
  });
});
