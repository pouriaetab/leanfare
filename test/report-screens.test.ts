// The report at the top of the Savings tab (report.ts, ui/app.js): four tiles, tokens over time, work by model,
// quality by kind, each prompt with its parts and its app's own row, a span or a filter asked again, and the CSV.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  test("four tiles, tokens over time, work by model, quality by kind and the prompts", async () => {
    const doc = await open(url);
    await goReport(doc);
    const tiles = [...doc.querySelectorAll("#reportCard .rp-tile")].map((t: any) => t.textContent);
    expect(tiles[0]).toContain("Kept out of your plans40k tokens");
    expect(tiles[0]).toContain("91% of your apps' use where it is known"); // 30k of 30k + 3k measured; the Claude chat's is not known
    expect(tiles[1]).toContain("3k new tokens");
    expect(tiles[1]).toContain("Claude: not known · Claude Code 3k, measured · 40k more read again from the cache");
    expect(tiles[2]).toContain("50% of parts free or on this computer · 2 parts in 2 prompts");
    expect(tiles[3]).toContain("50% good");
    expect(doc.querySelectorAll("#reportCard .rp-chart path.l1, #reportCard .rp-chart path.l2")).toHaveLength(2);
    expect([...doc.querySelectorAll("#reportCard .rp-bar .nm span")].map((e: any) => e.textContent)).toEqual(["Gemini 3.8 Flash", "DeepSeek V4 Flash"]);
    expect([...doc.querySelectorAll("#reportCard .rp-kind .nm b")].map((e: any) => e.textContent)).toEqual(["Reading", "Drafting"]);
    const rows = [...doc.querySelectorAll("#reportCard tr.pr")].map((r: any) => [...r.querySelectorAll("td")].map((td: any) => td.textContent.trim()));
    expect(rows.map((r) => [r[1], r[2], r[3], r[5], r[6], r[8]])).toEqual([
      ["Claude", "Claude Opus 5.5", "not known", "10k", "—", "× wrong"],
      ["Claude Code", "Claude Opus 5.5", "100 → 1k", "30k", "91%", "✓ good"],
    ]);
    expect(bad(doc)).toBe(false);
  });

  test("a prompt opens to its parts and its app's own work", async () => {
    const doc = await open(url);
    await goReport(doc);
    ([...doc.querySelectorAll("#reportCard tr.pr")] as any[])[1].click();
    await waitFor(() => doc.querySelectorAll("#reportCard tr.part").length === 2);
    const parts = [...doc.querySelectorAll("#reportCard tr.part")].map((r: any) => r.textContent);
    expect(parts[0]).toContain("1 · reading");
    expect(parts[0]).toContain("30k read → 500");
    expect(parts[0]).toContain("free · 6 s");
    expect(parts[1]).toContain("prompt 100, its own work 3k new tokens (measured), 40k more read again from the cache");
  });

  test("a span or a filter is asked again, and the CSV holds the prompts and their parts", async () => {
    const doc = await open(url);
    await goReport(doc);
    ([...doc.querySelectorAll("#reportCard .seg button")] as any[]).find((b) => b.textContent === "Today").click();
    await waitFor(() => outgoing.some((u) => u.includes("/api/report?range=today")));
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
    expect(lines[0]).toStartWith("time,app,thread,project,main_model,plan,prompt_tokens");
    expect(lines.slice(1).map((l: string) => l.split(",").slice(1, 2)[0])).toEqual(["Claude", "Claude"]); // the prompt, then its part
    expect(lines[2]).toContain("DeepSeek V4 Flash,paid,10000,900");
  });

  test("the report tool's link (#report) opens Savings at the report, whatever screen was open last", async () => {
    const doc = await open(url, { screen: "plan", hash: "#report" });
    await waitFor(() => !!doc.querySelector("#reportCard .rp-tiles"));
    expect(doc.querySelector('.tabs button[data-tab="savings"]').getAttribute("aria-selected")).toBe("true");
    expect(doc.querySelector("#reportCard .rp-tile").textContent).toContain("Kept out of your plans");
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
});
