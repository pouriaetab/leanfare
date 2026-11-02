// What was paid, call by call (0.13.2): the spending pill at the top opens a list of this month's calls that cost
// something, newest first (when, the model, what for, the tokens and the cost); their total is the pill's. Free and local
// answers are not listed. The Mac app's menu opens the same list (POST /api/open, then the page), and so does #spend.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getModel } from "../src/data";
import { db } from "../src/db";
import { ALL_TICKED, boot, reset, ui } from "./app";
import { closeApp, openApp, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 9000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
// A call in the ledger: when (an ISO time), what for, the model and its provider, the tokens and the cost.
function call(ts: string, source: string, provider: string, model: string, cost: number, status = "ok") {
  db.query("INSERT INTO ledger(ts, month, day, source, provider, model, auto, in_tokens, cached, cache_write, out_tokens, cost, list_cost, price_status, usage_status, status, ms, first_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 9900, 0, 0, 120, ?, ?, 'listed', 'reported', ?, 2000, 900)")
    .run(ts, ts.slice(0, 7), ts.slice(0, 10), source, provider, model, cost, cost, status);
}
const MINI = "openai/gpt-5-mini", DEEP = "deepseek/deepseek-v4-flash", FLASH = "google/gemini-3.8-flash";

describe("what was paid, call by call", () => {
  test("this month's paid calls, newest first, with what each was for; free ones and last month's are not listed; the total is the pill's", async () => {
    call("2026-10-21T09:00:00.000Z", "delegate", "deepseek", DEEP, 0.0012);
    call("2026-10-21T10:00:00.000Z", "plan", "google", FLASH, 0); // free
    call("2026-10-21T11:00:00.000Z", "check", "openai", MINI, 0.0057);
    call("2026-09-30T11:00:00.000Z", "chat", "openai", MINI, 0.5); // last month
    const v = (await ui(url, "/api/spend")).json;
    expect(v).toMatchObject({ span: "month", count: 2 });
    expect(v.total).toBeCloseTo(0.0069, 10);
    expect(v.items.map((x: any) => [x.what, x.model, x.provider, x.cost, x.input, x.output])).toEqual([
      ["Check", getModel(MINI)!.label, "OpenAI", 0.0057, 9900, 120],
      ["Hand off", getModel(DEEP)!.label, "DeepSeek", 0.0012, 9900, 120],
    ]);
    const st = (await ui(url, "/api/state")).json;
    expect(st.month.spent).toBeCloseTo(v.total, 10);
    expect((await ui(url, "/api/spend?span=today")).json.count).toBe(2);
  });
  test("on the page: the pill opens the list, Show all opens the rest, and Esc closes it", async () => {
    for (let i = 0; i < 8; i++) call(`2026-10-21T0${i}:30:00.000Z`, "delegate", "deepseek", DEEP, 0.001 * (i + 1));
    call("2026-10-21T09:00:00.000Z", "check", "openai", MINI, 0.0057, "error");
    const doc = await openApp(url);
    doc.querySelector("#spendPill").click();
    await waitFor(() => doc.querySelectorAll("#spendPop .sp-row").length > 0);
    const pop = doc.querySelector("#spendPop");
    expect(pop.querySelector(".sp-sums").textContent).toContain("this month");
    const rows = [...pop.querySelectorAll(".sp-row")];
    expect(rows.length).toBe(6); // the newest six, then Show all
    expect(rows[0].querySelector(".sp-model").textContent).toBe(getModel(MINI)!.label);
    expect(rows[0].querySelector(".sp-cost").textContent).toBe("$0.0057");
    expect(rows[0].querySelector(".sp-sub").textContent).toContain("Check, failed after it began · OpenAI · 10k in, 120 out");
    const all = [...pop.querySelectorAll(".sp-link")].find((b: any) => b.textContent === "Show all 9")!;
    all.click();
    expect(doc.querySelectorAll("#spendPop .sp-row").length).toBe(9);
    expect(doc.querySelector("#spendPop .sp-note").textContent).toBe("Free and local answers cost $0, so they are not listed.");
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(doc.querySelector("#spendPop")).toBe(null);
  }, 20000);
  test("nothing paid: it says so", async () => {
    const doc = await openApp(url);
    doc.querySelector("#spendPill").click();
    await waitFor(() => !!doc.querySelector("#spendPop .sp-note") && !doc.querySelector("#spendPop").textContent.includes("Reading"));
    expect(doc.querySelector("#spendPop").textContent).toContain("Nothing paid this month. Free and local answers cost $0.");
  }, 20000);
  test("the Mac app's menu opens it: POST /api/open, and the page opens the list once; #spend in the address too", async () => {
    call("2026-10-21T11:00:00.000Z", "check", "openai", MINI, 0.0057);
    expect((await ui(url, "/api/open", { what: "nothing" })).status).toBe(400);
    const doc = await openApp(url);
    expect(doc.querySelector("#spendPop")).toBe(null);
    expect((await ui(url, "/api/open", { what: "spend" })).json).toEqual({ ok: true });
    expect((await ui(url, "/api/state")).json.open).toMatchObject({ what: "spend" });
    await waitFor(() => doc.querySelectorAll("#spendPop .sp-row").length === 1, 12000); // the page reads the state every 4 seconds
    expect(doc.querySelectorAll("#spendPop .sp-row").length).toBe(1);
    await closeApp();
    const again = await openApp(url, { hash: "#spend" });
    await waitFor(() => again.querySelectorAll("#spendPop .sp-row").length === 1);
    expect(again.querySelectorAll("#spendPop .sp-row").length).toBe(1);
  }, 30000);
});
