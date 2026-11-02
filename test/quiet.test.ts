// Quiet (0.13.5): a state that can last for weeks (a VPN a provider blocks, an account with no credit, a refused key)
// is said once, not all the time. One press on a notice's × hides it until the state changes, and the provider's card
// in Settings still says it, with its own Check again. A hand off's receipt says each one once a day.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runDelegate } from "../src/delegate";
import { awayLeftOut, clearAway, creditLeftOut, keysLeftOut, KEYS_EVERY, noteAway, noteNoCredit, noteRefused } from "../src/keystate";
import { saveSettings } from "../src/settings";
import { now } from "../src/util";
import { boot, keys, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

const MINI = "openai/gpt-5-mini", CLAUDE = "anthropic/claude-sonnet-4-6";
let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ mode: "save" });
  await keys("openai", "anthropic", "deepseek");
  saveSettings({ ticked: [MINI, CLAUDE] });
});
afterEach(closeApp);
async function waitFor(ok: () => boolean, ms = 3000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }
const notices = async () => (await ui(url, "/api/state")).json.notices.filter((x: any) => x.provider === "openai");
const handOff = () => runDelegate({ task: "Say hi [usage 100 10]", files: [], kind: "write", effort: "low", check: "never", maxOut: 1000 } as any, new AbortController().signal);

describe("a notice hidden until it changes", () => {
  test("× hides it; the card still says it, with Check again; a new spell shows it again", async () => {
    noteAway("openai", 403, true);
    expect((await notices()).map((x: any) => x.kind)).toEqual(["away"]);
    const r = await ui(url, "/api/notices/hide", { provider: "openai", kind: "away" });
    expect(r.json.ok).toBe(true);
    expect(r.json.state.notices.some((x: any) => x.provider === "openai")).toBe(false);
    expect(r.json.state.providers.find((p: any) => p.id === "openai").keyTrouble.away).toMatchObject({ status: 403 }); // still out, still said in Settings
    clearAway("openai"); // it answered
    noteAway("openai", 403, true); // and later turned requests away again
    expect((await notices()).map((x: any) => x.kind)).toEqual(["away"]);
  });
  test("the same for no credit and a refused key; a provider or kind it does not know is refused", async () => {
    noteNoCredit("openai", 402);
    await ui(url, "/api/notices/hide", { provider: "openai", kind: "credit" });
    expect(await notices()).toEqual([]);
    noteRefused("openai", 401);
    expect((await notices()).map((x: any) => x.kind)).toEqual(["key"]);
    await ui(url, "/api/notices/hide", { provider: "openai", kind: "key" });
    expect(await notices()).toEqual([]);
    expect((await ui(url, "/api/notices/hide", { provider: "openai", kind: "nope" })).status).toBe(400);
    expect((await ui(url, "/api/notices/hide", { provider: "nobody", kind: "away" })).status).toBe(400);
  });
  test("on the page: × takes the notice away, and the provider's card keeps the chip and Check again", async () => {
    noteAway("openai", 403, true);
    const doc = await openApp(url, { screen: "settings" });
    for (let i = 0; i < 100 && !doc.querySelector(".prov-head"); i++) await Bun.sleep(50);
    const notice = () => [...doc.querySelectorAll("#notices .notice")].find((x: any) => x.textContent.includes("OpenAI blocks requests")) as any;
    expect(notice()).toBeTruthy();
    notice().querySelector(".notice-x").click();
    await waitFor(() => !notice());
    expect(notice()).toBeFalsy();
    const card = () => ([...doc.querySelectorAll(".prov-head")].find((x: any) => x.querySelector(".name")?.textContent === "OpenAI") as any)?.closest(".prov");
    expect(card().querySelector(".chip").textContent).toBe("Turned away");
    card().querySelector(".prov-head").click(); // the cards are drawn again: look each time
    await waitFor(() => !!card()?.querySelector(".prov-body"));
    expect([...card().querySelectorAll(".prov-body button")].map((b: any) => b.textContent)).toContain("Check again");
  }, 20000);
});

describe("a receipt says it once a day", () => {
  test("turned away, no credit, a refused key: said in the first receipt, then again a day later", () => {
    const t = now().getTime(), day = KEYS_EVERY.say;
    noteAway("openai", 403, true);
    expect(awayLeftOut(["openai"], t)).toBe("OpenAI is turning requests away, so its models were left out. Leanfare checks again every 30 minutes.");
    expect(awayLeftOut(["openai"], t + 60_000)).toBe(null);
    expect(awayLeftOut(["openai"], t + day + 60_000)).not.toBe(null);
    noteNoCredit("deepseek", 402);
    expect(creditLeftOut(["deepseek"], t)).not.toBe(null);
    expect(creditLeftOut(["deepseek"], t + 60_000)).toBe(null);
    noteRefused("anthropic", 401);
    expect(keysLeftOut(["anthropic"], t)).not.toBe(null);
    expect(keysLeftOut(["anthropic"], t + 60_000)).toBe(null);
  });
  test("two hand offs in a row: the first receipt says it, the second does not", async () => {
    noteAway("openai", 403, true);
    const line = "OpenAI is turning requests away, so its models were left out.";
    expect((await handOff()).receipt).toContain(line);
    expect((await handOff()).receipt).not.toContain(line);
  });
});
