// The screens as you use them: the real ui/app.js in happy-dom (a browser
// without a screen), against the real test server.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, fake, keys, ledger, reset, ui } from "./app";
import { refreshOllama } from "../src/data";
import { appJs, choose, closeApp, key, openApp as open, type, waitIdle, win } from "./dom";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
afterEach(closeApp);
const openApp = () => open(url);

describe("the screens", () => {
  test("Enter while an answer is written does not stop it, and keeps what you typed", async () => {
    await reset({ ticked: ALL_TICKED });
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "a long one [chunks 30]");
    key(ta, "Enter");
    await Bun.sleep(300);
    expect(doc.querySelector("button.send").textContent).toBe("Stop");
    type(ta, "and my next question");
    key(ta, "Enter");
    await waitIdle(doc);
    await Bun.sleep(300);
    expect(ledger().map((r) => r.status)).toEqual(["ok"]);
    expect(ta.value).toBe("and my next question");
  }, 20000);

  test("the model picker never shows Auto while messages go to another model", async () => {
    await reset({ ticked: ["openai/gpt-5-mini", "google/gemini-3.8-flash"] });
    await keys("openai", "google");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    await Bun.sleep(100);
    await ui(url, "/api/models/tick", { ids: ["openai/gpt-5-mini"], on: false }); // from Settings in another tab
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    await Bun.sleep(500);
    const pick = doc.querySelector("select[aria-label=Model]");
    expect(pick.options[pick.selectedIndex].textContent).toContain("Auto");
    const ta = doc.querySelector("textarea");
    type(ta, "What is the capital of Australia?");
    key(ta, "Enter");
    await waitIdle(doc);
    expect(ledger()[0].model).toBe("google/gemini-3.8-flash");
  }, 20000);

  test("a background redraw keeps an unsaved budget and a running key test's Stop", async () => {
    await reset({ ticked: ALL_TICKED });
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() { await Bun.sleep(8000); return Response.json({ data: [] }); } });
    process.env.LEANFARE_OPENAI_BASE = `http://127.0.0.1:${slow.port}/v1`;
    try {
      const doc = await openApp();
      doc.querySelector('.tabs button[data-tab="settings"]').click();
      await Bun.sleep(200);
      const budget = () => doc.querySelector('input[aria-label="Monthly budget"]');
      budget().value = "5";
      budget().dispatchEvent(new win.Event("input", { bubbles: true }));
      [...doc.querySelectorAll(".prov-head")].find((h: any) => h.textContent.includes("OpenAI")).click();
      await Bun.sleep(200);
      doc.querySelector('input[aria-label="OpenAI key"]').value = "sk-test-openai-0001";
      const btn = () => [...doc.querySelectorAll(".prov.open button")].find((b: any) => b.textContent === "Stop" || b.textContent === "Test and save");
      btn().click();
      await Bun.sleep(200);
      expect(btn().textContent).toBe("Stop");
      await refreshOllama(); // a background check that changes the state
      await Bun.sleep(4500); // one poll
      expect(budget().value).toBe("5");
      expect(btn().textContent).toBe("Stop");
      btn().click(); // Stop works
      await Bun.sleep(300);
      expect(btn().textContent).toBe("Test and save");
    } finally { process.env.LEANFARE_OPENAI_BASE = (globalThis as any).__fake.bases.openai; slow.stop(true); }
  }, 25000);

  test("only the last answer offers Start again", async () => {
    await reset({ ticked: ALL_TICKED });
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "first, a long one [chunks 40]"); key(ta, "Enter");
    await Bun.sleep(700); // a click in the first half second is taken for the second click of a double click
    doc.querySelector("button.send").click(); // Stop
    await Bun.sleep(1000);
    expect([...doc.querySelectorAll(".msg button")].some((b: any) => b.textContent === "Start again")).toBe(true);
    type(ta, "second question"); key(ta, "Enter");
    await waitIdle(doc);
    await Bun.sleep(500);
    expect([...doc.querySelectorAll(".msg button")].some((b: any) => b.textContent === "Start again")).toBe(false);
    expect(doc.querySelector(".chip.warn")?.textContent).toBe("Stopped");
  }, 25000);
});

describe("the chat's edge cases", () => {
  beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
  const texts = (doc: any, sel: string) => [...doc.querySelectorAll(sel)].map((e: any) => e.textContent);

  test("a refused message shows why, with Try again, and never an older answer", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "How do I add up a column? [usage 1000 100]"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(300);
    expect(doc.querySelectorAll(".msg.ai")).toHaveLength(1);
    await ui(url, "/api/settings", { budget: 0.0001, atLimit: "stop" });
    type(ta, "And a row?"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(900);
    const answers = doc.querySelectorAll(".msg.ai");
    expect(answers).toHaveLength(2);
    expect(answers[1].querySelector(".err-box")?.textContent).toContain("budget");
    expect(texts(answers[1], "button")).toContain("Try again");
    expect(answers[1].textContent).not.toContain("Stopped");
    expect(answers[1].querySelector(".body").textContent).toBe("");
  }, 20000);

  test("Again that is refused keeps the earlier answer on screen", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "Write a short story [usage 1000 100]"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(300);
    const story = doc.querySelector(".msg.ai .body").textContent;
    expect(story.length).toBeGreaterThan(0);
    await ui(url, "/api/settings", { budget: 0.0001, atLimit: "stop" });
    [...doc.querySelectorAll(".msg.ai button")].find((b: any) => b.textContent === "Again").click();
    await waitIdle(doc); await Bun.sleep(900);
    expect(doc.querySelectorAll(".msg.ai")).toHaveLength(1);
    expect(doc.querySelector(".msg.ai .body").textContent).toBe(story);
    expect(doc.querySelector("#toasts").textContent).toContain("earlier answer is kept");
  }, 20000);

  test("an open edit box stays in its own chat", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "First chat question"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(300);
    doc.querySelector(".chats-head .btn.primary").click(); await Bun.sleep(200);
    type(ta, "Second chat question"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(500);
    doc.querySelector(".edit-btn").click(); await Bun.sleep(100);
    const edit = doc.querySelector(".edit-ta");
    edit.value = "typed in the second chat";
    const first = [...doc.querySelectorAll(".chat-item")].find((el: any) => el.textContent.includes("First chat"));
    first.click(); await Bun.sleep(500);
    expect(doc.querySelector(".edit-ta")).toBeNull();
    expect(doc.querySelector(".msg.user .bubble").textContent).toBe("First chat question");
    doc.querySelector(".edit-btn").click(); await Bun.sleep(100);
    doc.querySelector(".chats-head .btn.primary").click(); await Bun.sleep(200);
    type(ta, "Third chat question"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(300);
    expect(doc.querySelector(".edit-ta")).toBeNull();
  }, 25000);

  test("the second click of a double click on Send does not stop the answer", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    type(doc.querySelector("textarea"), "Plan a trip [chunks 20] [usage 300 600]");
    const send = doc.querySelector("button.send");
    send.dispatchEvent(new win.MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
    await Bun.sleep(300);
    expect(send.textContent).toBe("Stop");
    send.dispatchEvent(new win.MouseEvent("click", { detail: 2, bubbles: true, cancelable: true }));
    await waitIdle(doc); await Bun.sleep(300);
    expect(ledger().map((r) => r.status)).toEqual(["ok"]);
  }, 20000);

  test("default instructions saved in Settings apply to the new chat on screen", async () => {
    await keys("openai");
    const doc = await openApp();
    await ui(url, "/api/settings", { instructions: "Answer in French." });
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    await Bun.sleep(600);
    expect(doc.querySelector("#convoHead .chip-btn").textContent).toBe("Instructions on");
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "Hello"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(300);
    const chats = (await ui(url, "/api/chats")).json.chats;
    expect((await ui(url, `/api/chats/${chats[0].id}`)).json.chat.system).toBe("Answer in French.");
  }, 20000);

  test("Esc while renaming a chat keeps its name", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "Keep this name"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(400);
    doc.querySelector('.chat-item button[title="Rename this chat"]').click(); await Bun.sleep(100);
    const input = doc.querySelector('.chat-item input[aria-label="Chat name"]');
    input.value = "A name I did not want";
    key(input, "Escape");
    input.dispatchEvent(new win.Event("blur")); // a browser blurs the box as the list redraws without it
    await Bun.sleep(400);
    expect((await ui(url, "/api/chats")).json.chats[0].title).toBe("Keep this name");
  }, 20000);

  test("Esc meant for the search box does not stop an answer", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "A long answer please [chunks 30] [usage 300 600]"); key(ta, "Enter");
    await Bun.sleep(400);
    const search = doc.querySelector('input[aria-label="Search chats"]');
    search.focus(); search.value = "abc";
    key(search, "Escape");
    await waitIdle(doc); await Bun.sleep(300);
    expect(ledger().map((r) => r.status)).toEqual(["ok"]);
  }, 20000);

  test("a Stop before the chat has a name still keeps the follow-up in the same chat", async () => {
    await keys("openai");
    const doc = await openApp();
    choose(doc, "openai/gpt-5-mini");
    const ta = doc.querySelector("textarea");
    type(ta, "What is a good name for a bakery? [slow 1500] [usage 100 50]");
    key(ta, "Enter"); key(ta, "Escape");
    await waitIdle(doc); await Bun.sleep(1800);
    type(ta, "Make it shorter please"); key(ta, "Enter");
    await waitIdle(doc); await Bun.sleep(500);
    const chats = (await ui(url, "/api/chats")).json.chats;
    expect(chats).toHaveLength(1);
    const msgs = (await ui(url, `/api/chats/${chats[0].id}`)).json.messages;
    expect(msgs.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["What is a good name for a bakery? [slow 1500] [usage 100 50]", "Make it shorter please"]);
  }, 20000);
});

describe("Connect OpenRouter", () => {
  const fakeOr = (globalThis as any).__fake;
  const welcomeCard = (doc: any) => [...doc.querySelectorAll(".start")].find((c: any) => c.textContent.includes("OpenRouter"));
  const connectBtn = (doc: any) => [...doc.querySelectorAll("button")].find((b: any) => b.textContent === "Connect OpenRouter" || (b.textContent === "Stop" && welcomeCard(doc)?.contains(b)));
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function openWithOpener() {
    const doc = await openApp();
    const opened: string[] = [];
    win.open = (u: string) => { opened.push(u); return null; };
    return { doc, opened };
  }
  // The browser's side: open OpenRouter's link, press Authorize, land on Leanfare's callback page.
  async function authorizeInBrowser(link: string) {
    const r = await fetch(link, { redirect: "manual" });
    return fetch(r.headers.get("location")!);
  }

  test("the welcome card offers Connect OpenRouter; pressing it opens OpenRouter, and the page connects by itself", async () => {
    await reset();
    const { doc, opened } = await openWithOpener();
    expect(welcomeCard(doc).textContent).toContain("no key to copy");
    expect(welcomeCard(doc).textContent).toContain("or paste a key");
    connectBtn(doc).click();
    await Bun.sleep(400);
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).searchParams.get("code_challenge_method")).toBe("S256");
    expect(connectBtn(doc).textContent).toBe("Stop"); // the start button is its Stop
    expect(toasts(doc)).toContain("press Authorize");
    expect((await authorizeInBrowser(opened[0])).status).toBe(200);
    for (let i = 0; i < 40 && !welcomeCard(doc)?.textContent.includes("Connected"); i++) await Bun.sleep(200);
    expect(welcomeCard(doc).textContent).toContain("Connected");
    expect(toasts(doc)).toContain("Connected to OpenRouter");
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("Stop forgets the sign in, and the old link no longer works", async () => {
    await reset();
    const { doc, opened } = await openWithOpener();
    connectBtn(doc).click();
    await Bun.sleep(700); // past the half second a double click is ignored
    connectBtn(doc).click(); // Stop
    await Bun.sleep(400);
    expect(doc.querySelector(".start button.primary")).toBeTruthy();
    expect(connectBtn(doc).textContent).toBe("Connect OpenRouter");
    const res = await authorizeInBrowser(opened[0]);
    expect(res.status).toBe(400);
    expect(fakeOr.seen.filter((x: any) => x.path.endsWith("/auth/keys"))).toHaveLength(0);
    expect((await ui(url, "/api/state")).json.providers.find((p: any) => p.id === "openrouter").key.saved).toBe(false);
  }, 20000);

  test("a double click does not stop what the first click started", async () => {
    await reset();
    const { doc, opened } = await openWithOpener();
    const b = connectBtn(doc);
    b.click();
    b.dispatchEvent(new win.MouseEvent("click", { detail: 2, bubbles: true, cancelable: true }));
    await Bun.sleep(300);
    expect(connectBtn(doc).textContent).toBe("Stop");
    b.click(); // a second click inside the first half second is ignored too
    await Bun.sleep(300);
    expect(connectBtn(doc).textContent).toBe("Stop");
    expect(opened).toHaveLength(1);
    connectBtn(doc).click(); await Bun.sleep(700); connectBtn(doc).click(); await Bun.sleep(300); // clean up: Stop
  }, 20000);

  test("a refused sign in says why on the page that is waiting", async () => {
    await reset();
    fakeOr.oauth.failExchange = 403;
    const { doc, opened } = await openWithOpener();
    connectBtn(doc).click();
    await Bun.sleep(400);
    expect((await authorizeInBrowser(opened[0])).status).toBe(400);
    for (let i = 0; i < 40 && !toasts(doc).includes("did not accept the code"); i++) await Bun.sleep(200);
    expect(toasts(doc)).toContain("did not accept the code");
    expect(connectBtn(doc).textContent).toBe("Connect OpenRouter"); // can try again
  }, 20000);

  test("Settings: Connect again, the credit left, and the one year expiry note", async () => {
    await reset({ ticked: ALL_TICKED });
    const { doc, opened } = await openWithOpener();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await Bun.sleep(200);
    const head = () => [...doc.querySelectorAll(".prov-head")].find((h: any) => h.textContent.includes("OpenRouter"));
    head().click();
    await Bun.sleep(200);
    const body = () => doc.querySelector(".prov.open");
    expect([...body().querySelectorAll("button")].map((b: any) => b.textContent)).toContain("Connect OpenRouter");
    expect(body().textContent).not.toContain("expire unused credits"); // no key yet
    [...body().querySelectorAll("button")].find((b: any) => b.textContent === "Connect OpenRouter").click();
    await Bun.sleep(400);
    await authorizeInBrowser(opened[0]);
    for (let i = 0; i < 40 && ![...doc.querySelectorAll(".prov.open button")].some((b: any) => b.textContent === "Connect again"); i++) await Bun.sleep(200);
    expect([...body().querySelectorAll("button")].map((b: any) => b.textContent)).toContain("Connect again");
    expect(body().textContent).toContain("Credit left on OpenRouter: $7.50 of $10.00 bought.");
    expect(body().textContent).toContain("may expire unused credits a year after purchase");
    expect(bad(doc)).toBe(false);
  }, 25000);
});

describe("Local models", () => {
  const card = (doc: any) => doc.querySelector("#localCard");
  const buttons = (doc: any) => [...card(doc).querySelectorAll("button")];
  const dlBtn = (doc: any) => buttons(doc).find((b: any) => b.textContent === "Download" || b.textContent === "Stop");
  const nameBox = (doc: any) => card(doc).querySelector("input[aria-label='Model to download']");
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  const rows = (doc: any) => [...card(doc).querySelectorAll(".lrow .nm")].map((n: any) => n.textContent);
  async function openSettings() {
    await reset({ ticked: ALL_TICKED });
    await ui(url, "/api/refresh", { what: "ollama" });
  }
  async function goSettings(doc: any) {
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    for (let i = 0; i < 40 && !card(doc)?.textContent.includes("On this computer"); i++) await Bun.sleep(50);
  }
  async function waitFor(doc: any, ok: () => boolean, ms = 10000) {
    for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50);
  }
  const type = (el: any, v: string) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };

  test("the card lists what Ollama has, how big, whether it fits, and what is in memory", async () => {
    await openSettings();
    fake.ollama.models.push({ name: "gemma3:12b", model: "gemma3:12b", modified_at: "2026-10-10T00:00:00Z", size: 8.1e9, details: { family: "gemma3", parameter_size: "12.2B", quantization_level: "Q4_K_M" } });
    fake.ollama.loaded.push("gemma3:12b");
    const doc = await openApp();
    await goSettings(doc);
    const text = card(doc).textContent;
    expect(rows(doc)).toEqual(["gemma3:12b", "llama3.2"]);
    expect(text).toContain("On this computer · 2 models · 10 GB");
    expect(text).toContain("This computer has 16 GB of memory, about 11 GB of it usable for a model.");
    expect(text).toContain("200 GB of disk is free; Leanfare keeps 10 GB free.");
    const g = card(doc).querySelectorAll(".lrow")[0].textContent;
    expect(g).toContain("12.2B"); expect(g).toContain("Q4_K_M"); expect(g).toContain("8.1 GB"); expect(g).toContain("tight"); expect(g).toContain("in memory");
    const l = card(doc).querySelectorAll(".lrow")[1].textContent;
    expect(l).toContain("fits"); expect(l).not.toContain("in memory");
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("without Ollama there is one line with the download link, and nothing else", async () => {
    await openSettings();
    fake.ollama.down = true;
    await ui(url, "/api/refresh", { what: "ollama" });
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(doc, () => !!card(doc) && card(doc).textContent.includes("not running"));
    expect(card(doc).textContent).toBe("Local modelsOllama is not running on this computer. Get Ollama ↗");
    const a = card(doc).querySelector("a");
    expect(a.getAttribute("href")).toBe("https://ollama.com/download");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(nameBox(doc)).toBeNull();
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("Download turns into Stop, shows the bar moving, and ends with the model listed and ticked", async () => {
    await openSettings();
    fake.ollama.holding = true;
    const doc = await openApp();
    await goSettings(doc);
    expect(dlBtn(doc).textContent).toBe("Download");
    type(nameBox(doc), "gemma3:12b");
    dlBtn(doc).click();
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Stop");
    expect(dlBtn(doc).textContent).toBe("Stop"); // the start button is its Stop
    expect(dlBtn(doc).className).toContain("stop");
    expect(nameBox(doc).disabled).toBe(true);
    await waitFor(doc, () => card(doc).querySelector("#dlBar")?.getAttribute("aria-valuenow") === "37");
    const bar = card(doc).querySelector("#dlBar");
    expect(bar.getAttribute("aria-valuenow")).toBe("37");
    expect(bar.firstChild.style.width).toBe("37%");
    expect(card(doc).querySelector("#dlText").textContent).toBe("Downloading · 37% · 3.0 GB of 8.1 GB");
    expect(card(doc).querySelector("#dlBlock").textContent).toContain("tight");
    expect(card(doc).textContent).toContain("Stop keeps what is downloaded");
    fake.ollama.holding = false;
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Download" && rows(doc).includes("gemma3:12b"), 15000);
    expect(rows(doc)).toEqual(["gemma3:12b", "llama3.2"]);
    expect(toasts(doc)).toContain("Downloaded gemma3:12b (8.1 GB)");
    expect(card(doc).querySelector("#dlBlock").className).toContain("good");
    expect(((await ui(url, "/api/state")).json.settings.ticked as string[])).toContain("ollama/gemma3:12b");
    expect(bad(doc)).toBe(false);
  }, 30000);

  test("a double click on Download does not stop what the first click started", async () => {
    await openSettings();
    fake.ollama.holding = true;
    const doc = await openApp();
    await goSettings(doc);
    type(nameBox(doc), "gemma3:12b");
    dlBtn(doc).click();
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Stop");
    dlBtn(doc).dispatchEvent(new win.MouseEvent("click", { detail: 2, bubbles: true, cancelable: true }));
    dlBtn(doc).click(); // inside the first half second
    await Bun.sleep(300);
    expect(dlBtn(doc).textContent).toBe("Stop");
    expect((await ui(url, "/api/local/pull")).json.pull.active).toBe(true);
    await Bun.sleep(400);
    dlBtn(doc).click(); // a real Stop
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Download");
    fake.ollama.holding = false;
  }, 20000);

  test("Stop ends it, says what is kept, and Download goes on from there", async () => {
    await openSettings();
    fake.ollama.holding = true;
    const doc = await openApp();
    await goSettings(doc);
    type(nameBox(doc), "gemma3:12b");
    dlBtn(doc).click();
    await waitFor(doc, () => card(doc).querySelector("#dlBar")?.getAttribute("aria-valuenow") === "37");
    dlBtn(doc).click(); // Stop (a real one, well past the first half second)
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Download");
    expect(card(doc).querySelector("#dlBlock").textContent).toContain("Stopped. What was downloaded is kept; press Download to continue.");
    expect(rows(doc)).toEqual(["llama3.2"]);
    [...card(doc).querySelectorAll("button")].find((b: any) => b.textContent === "Dismiss").click();
    await waitFor(doc, () => !card(doc).querySelector("#dlBlock"));
    expect(card(doc).querySelector("#dlBlock")).toBeNull();
    expect(fake.ollama.partial["gemma3:12b"]).toBeGreaterThan(0);
  }, 25000);

  test("a failed download shows Ollama's reason in plain words until it is dismissed", async () => {
    await openSettings();
    fake.ollama.error = "write blobs/sha256-1: no space left on device";
    const doc = await openApp();
    await goSettings(doc);
    type(nameBox(doc), "gemma3:12b");
    dlBtn(doc).click();
    await waitFor(doc, () => card(doc).querySelector("#dlBlock")?.className.includes("bad"));
    expect(card(doc).querySelector("#dlBlock").textContent).toContain("The disk is full. Free some space, then press Download to continue.");
    expect(toasts(doc)).toContain("The disk is full");
    expect(dlBtn(doc).textContent).toBe("Download"); // can try again
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("a name Leanfare refuses is said at once, and nothing starts", async () => {
    await openSettings();
    const doc = await openApp();
    await goSettings(doc);
    dlBtn(doc).click(); // nothing typed
    await Bun.sleep(100);
    expect(toasts(doc)).toContain("Type the model's name first");
    type(nameBox(doc), "hf.co/onlyuser");
    dlBtn(doc).click();
    await waitFor(doc, () => toasts(doc).includes("That is not a model name"));
    expect(toasts(doc)).toContain("That is not a model name");
    expect(fake.seen.filter((x: any) => x.path === "/ollama/api/pull")).toHaveLength(0);
    expect(nameBox(doc).value).toBe("hf.co/onlyuser"); // what was typed stays
  }, 20000);

  test("a download that was started before the page opened is picked up, with its own Stop", async () => {
    await openSettings();
    fake.ollama.holding = true;
    await ui(url, "/api/local/pull", { name: "gemma3:12b" });
    for (let i = 0; i < 100 && !(await ui(url, "/api/local/pull")).json.pull?.percent; i++) await Bun.sleep(30);
    const doc = await openApp();
    await goSettings(doc);
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Stop");
    expect(dlBtn(doc).textContent).toBe("Stop");
    expect(nameBox(doc).value).toBe("gemma3:12b");
    await waitFor(doc, () => card(doc).querySelector("#dlBar")?.getAttribute("aria-valuenow") === "37");
    expect(card(doc).querySelector("#dlText").textContent).toContain("37%");
    await Bun.sleep(600);
    dlBtn(doc).click();
    await waitFor(doc, () => dlBtn(doc)?.textContent === "Download");
    fake.ollama.holding = false;
  }, 25000);

  test("Remove asks first, names the size it frees, and Keep changes nothing", async () => {
    await openSettings();
    const doc = await openApp();
    await goSettings(doc);
    const remove = () => buttons(doc).find((b: any) => b.textContent === "Remove");
    remove().click();
    expect(card(doc).querySelector(".lconfirm").textContent).toContain("Remove llama3.2:latest? This frees 2.0 GB. It cannot be undone here: to get it back you download it again.");
    [...card(doc).querySelectorAll(".lconfirm button")].find((b: any) => b.textContent === "Keep it").click();
    expect(card(doc).querySelector(".lconfirm")).toBeNull();
    expect(rows(doc)).toEqual(["llama3.2"]);
    expect(fake.seen.filter((x: any) => x.method === "DELETE")).toHaveLength(0);
  }, 20000);

  test("Remove it takes the model off the disk, out of the picker, and says what it freed", async () => {
    await openSettings();
    const doc = await openApp();
    await goSettings(doc);
    expect([...doc.querySelectorAll("select[aria-label=Model] option")].some((o: any) => o.value === "ollama/llama3.2:latest")).toBe(true);
    buttons(doc).find((b: any) => b.textContent === "Remove").click();
    [...card(doc).querySelectorAll(".lconfirm button")].find((b: any) => b.textContent === "Remove it").click();
    await waitFor(doc, () => toasts(doc).includes("Removed llama3.2:latest. Freed 2.0 GB."));
    expect(toasts(doc)).toContain("Removed llama3.2:latest. Freed 2.0 GB.");
    await waitFor(doc, () => card(doc).textContent.includes("No models yet"));
    expect(card(doc).textContent).toContain("No models yet. Download one below.");
    expect(fake.ollama.models).toHaveLength(0);
    expect([...doc.querySelectorAll("select[aria-label=Model] option")].some((o: any) => o.value === "ollama/llama3.2:latest")).toBe(false);
    expect(bad(doc)).toBe(false);
  }, 25000);

  test("when Ollama refuses a removal, the reason shows and the model stays", async () => {
    await openSettings();
    fake.ollama.deleteStatus = 500;
    const doc = await openApp();
    await goSettings(doc);
    buttons(doc).find((b: any) => b.textContent === "Remove").click();
    [...card(doc).querySelectorAll(".lconfirm button")].find((b: any) => b.textContent === "Remove it").click();
    await waitFor(doc, () => toasts(doc).includes("Ollama would not remove it"));
    expect(toasts(doc)).toContain("Ollama would not remove it: fake delete failure");
    expect(rows(doc)).toEqual(["llama3.2"]);
  }, 20000);

  test("what is typed in the name box survives other changes on the page", async () => {
    await openSettings();
    const doc = await openApp();
    await goSettings(doc);
    type(nameBox(doc), "hf.co/acme/small-GGUF:Q4_K_M");
    const use = [...doc.querySelectorAll(".prov-head")].find((h: any) => h.textContent.includes("Ollama"));
    use.click(); // opens the provider card: the whole page redraws
    await Bun.sleep(150);
    expect(nameBox(doc).value).toBe("hf.co/acme/small-GGUF:Q4_K_M");
  }, 20000);
});

describe("the markdown renderer", () => {
  const src = appJs.slice(appJs.indexOf("const esc = (s) =>"), appJs.indexOf('document.addEventListener("click"'));
  const { markdown } = new Function(src + "\nreturn { markdown };")();
  test("a NUL character in an answer cannot break it", () => {
    expect(() => markdown("a \u00001\u0000 b")).not.toThrow();
    expect(markdown("x `y` \u00005\u0000")).toContain("<code>y</code>");
  });
  test("random input never produces a tag or attribute outside the allowed set", async () => {
    const allowedEl = new Set(["p", "br", "h1", "h2", "h3", "h4", "hr", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "ul", "ol", "li", "pre", "button", "code", "a", "strong", "em", "del"]);
    const allowedAttr = new Set(["href", "target", "rel", "class", "type"]);
    const pieces = ["*", "_", "**", "__", "~~", "`", "[", "]", "(", ")", "https://x.com/", '"', "'", "<", ">", "&", " ", "\n", "|", "-", "#", "javascript:alert(1)", " onmouseover=alert(1) ", "<img src=x onerror=alert(1)>", "```", "1. ", "a", "\u0000", "0", "&quot;", '" onx="', "=", "/"];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const problems: string[] = [];
    for (let i = 0; i < 20000; i++) {
      let s = "";
      for (let j = 0, len = 2 + rnd(14); j < len; j++) s += pieces[rnd(pieces.length)];
      const out = markdown(s);
      await new HTMLRewriter().on("*", { element(el) {
        if (!allowedEl.has(el.tagName)) problems.push(`element ${el.tagName} from ${JSON.stringify(s)}`);
        for (const [k, v] of el.attributes) {
          if (!allowedAttr.has(k)) problems.push(`attribute ${k} from ${JSON.stringify(s)}`);
          if (k === "href" && !/^https?:\/\//.test(v)) problems.push(`link ${v} from ${JSON.stringify(s)}`);
        }
      } }).transform(new Response(out)).text();
    }
    expect(problems.slice(0, 5)).toEqual([]);
  }, 60000);
});

describe("Your plans", () => {
  const { mkdirSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { forgetLogs } = require("../src/plans") as typeof import("../src/plans");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const line = (id: string, model: string, usage: Record<string, number>) => JSON.stringify({ type: "assistant", timestamp: "2026-10-20T10:00:00Z", requestId: "r" + id, message: { id: "m" + id, model, usage } });
  const logs = (...lines: string[]) => {
    const d = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "p");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s.jsonl"), lines.join("\n") + "\n");
    forgetLogs();
  };
  beforeEach(async () => {
    rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
    rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
    forgetLogs();
    await reset({ ticked: ALL_TICKED });
  });
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  const goSavings = async (doc: any) => {
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#plansCard") && !doc.querySelector("#plansCard").textContent.includes("Reading"));
  };
  const goSettings = async (doc: any) => {
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector("input[aria-label='Claude plan name']"));
  };
  const set = (el: any, v: string) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const press = (doc: any, text: string, within = "body") => [...doc.querySelector(within).querySelectorAll("button")].find((b: any) => b.textContent === text)?.click();

  test("no plan and no log files: the card says what to do, and nothing reads null", async () => {
    const doc = await openApp();
    await goSavings(doc);
    const t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("Your subscriptions");
    expect(t).toContain("a fixed price, with limits");
    expect(t).toContain("Enter your Claude, ChatGPT or other plan");
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("log files and a plan: tokens first and each model in tokens; dollars at API prices only when Settings shows them", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 100_000 }), line("2", "claude-future-9", { input_tokens: 5000, output_tokens: 10 }));
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 1.5 } } });
    let doc = await openApp();
    await goSavings(doc);
    let t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("Claude Max");
    expect(t).toContain("$1.50 a month");
    expect(t).toContain("1.1Mtokens this month in Claude Code"); // the big number, then what it is
    expect(t).toContain("Claude Sonnet 4.6");
    expect(t).toContain("1.1M tokens"); // its bar
    expect(t).toContain("claude-future-9");
    expect(t).not.toContain("$4.50");
    expect(t).not.toContain("at API prices");
    expect(t).not.toContain("what you pay");
    expect(doc.querySelectorAll("#plansCard .pl").length).toBe(1); // no Codex logs and no ChatGPT plan: nothing to show for it
    expect(doc.querySelector("#plansCard .pl details summary").textContent).toBe("By model, and what still fits"); // the rest is folded
    expect(bad(doc)).toBe(false);
    await ui(url, "/api/settings", { showValue: true });
    doc = await openApp();
    await goSavings(doc);
    t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("$4.50"); // $3 in + $1.50 out
    expect(t).toContain("at API prices");
    expect(t).toContain("3.0× what you pay");
    expect(t).toContain("no listed price");
    expect(t).toContain("5.0k tokens are on models with no listed price");
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("the ChatGPT block shows Codex's own limits as of its last message, and never invents any for Claude", async () => {
    const cd = join(process.env.CODEX_HOME!, "sessions", "d");
    mkdirSync(cd, { recursive: true });
    writeFileSync(join(cd, "rollout-1.jsonl"), [
      JSON.stringify({ timestamp: "2026-10-20T13:00:00Z", type: "turn_context", payload: { model: "gpt-4.1" } }),
      JSON.stringify({ timestamp: "2026-10-20T13:05:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 }, last_token_usage: null }, rate_limits: { primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1792590000 }, secondary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1792900000 }, plan_type: "plus" } } }),
    ].join("\n") + "\n");
    forgetLogs();
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 0 }));
    const doc = await openApp();
    await goSavings(doc);
    const t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("Codex limits at its last message");
    expect(t).toContain("1% of the 5 hour limit used");
    expect(t).toContain("12.5% of the weekly limit used");
    expect(t).toContain("resets");
    expect(t.match(/limits at its last message/g)!.length).toBe(1); // Claude Code has none to show
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("log files but no plan yet: the tokens show, with a way to enter the plan", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    const doc = await openApp();
    await goSavings(doc);
    const t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("Claude Code");
    expect(t).toContain("1.0Mtokens this month");
    expect(t).not.toContain("$3");
    expect(t).not.toContain("what you pay");
    press(doc, "Enter your plan", "#plansCard");
    await waitFor(() => !!doc.querySelector("input[aria-label='Claude plan name']"));
    expect(doc.querySelector("input[aria-label='Claude plan name']")).toBeTruthy();
  }, 20000);

  test("a plan with no log files says so", async () => {
    await ui(url, "/api/settings", { plans: { chatgpt: { name: "ChatGPT Plus", price: 20 } } });
    const doc = await openApp();
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).toContain("No Codex log files found on this computer.");
  }, 20000);

  test("Look again reads the files again, and Stop works while it does", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Pro", price: 6 } } });
    const doc = await openApp();
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).toContain("1.0Mtokens this month");
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }), line("2", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    press(doc, "Look again", "#plansCard");
    expect(doc.querySelector("#plansCard button").textContent).toBe("Stop"); // it is its own Stop while it reads
    await waitFor(() => doc.querySelector("#plansCard").textContent.includes("2.0Mtokens this month"));
    expect(doc.querySelector("#plansCard").textContent).toContain("2.0M tokens"); // the model's bar too
    expect(toasts(doc)).toContain("Log files read again.");
    expect(doc.querySelector("#plansCard button").textContent).toBe("Look again"); // the button is back with its label
  }, 20000);

  test("changing the month on Savings shows that month's use, never the last month's under it", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    const doc = await openApp();
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).toContain("1.0Mtokens this month");
    await Bun.sleep(300);
    const pick = doc.querySelector("#tab-savings select[aria-label='Month']");
    pick.value = "2026-09";
    pick.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => doc.querySelector("#plansCard")?.textContent.includes("No Claude Code use in this month"));
    expect(doc.querySelector("#plansCard").textContent).toContain("No Claude Code use in this month's log files.");
    expect(doc.querySelector("#plansCard").textContent).not.toContain("1.0Mtokens");
  }, 20000);

  test("Settings: save a plan, see it on Savings, change it, remove it", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    const doc = await openApp();
    await goSettings(doc);
    set(doc.querySelector("input[aria-label='Claude plan name']"), "Claude Max");
    set(doc.querySelector("input[aria-label='Claude plan price a month']"), "100");
    press(doc, "Save", ".plan-row");
    await waitFor(() => toasts(doc).includes("Claude plan saved."));
    expect((await ui(url, "/api/state")).json.settings.plans).toEqual({ claude: { name: "Claude Max", price: 100 } });
    expect(doc.querySelector("input[aria-label='Claude plan name']").value).toBe("Claude Max");
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).toContain("$100.00 a month");
    expect(doc.querySelector("#plansCard").textContent).not.toContain("what you pay"); // no dollars of use unless asked
    await goSettings(doc);
    const showIt = [...doc.querySelectorAll("label.check")].find((l: any) => l.textContent.includes("cost per use, at API prices"))!.querySelector("input");
    showIt.checked = true;
    showIt.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => toasts(doc).includes("also shows what your plan use would cost"));
    expect((await ui(url, "/api/state")).json.settings.showValue).toBe(true);
    await goSavings(doc);
    await waitFor(() => doc.querySelector("#plansCard").textContent.includes("what you pay"));
    expect(doc.querySelector("#plansCard").textContent).toContain("under 0.1× what you pay"); // never "0.0×"
    await goSettings(doc);
    const remove = [...doc.querySelectorAll(".plan-row button")].find((b: any) => b.textContent === "Remove");
    remove.click();
    await waitFor(() => toasts(doc).includes("Claude plan removed."));
    expect((await ui(url, "/api/state")).json.settings.plans).toEqual({});
    expect(doc.querySelector("input[aria-label='Claude plan name']").value).toBe("");
    expect(bad(doc)).toBe(false);
  }, 30000);

  test("a plan entered in Settings is on the Savings card when you go back, without pressing anything", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    const doc = await openApp();
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).not.toContain("Claude Max");
    await goSettings(doc);
    set(doc.querySelector("input[aria-label='Claude plan name']"), "Claude Max");
    set(doc.querySelector("input[aria-label='Claude plan price a month']"), "6");
    press(doc, "Save", ".plan-row");
    await waitFor(() => toasts(doc).includes("Claude plan saved."));
    await goSavings(doc);
    await waitFor(() => doc.querySelector("#plansCard").textContent.includes("Claude Max"));
    expect(doc.querySelector("#plansCard").textContent).toContain("$6.00 a month");
    expect(doc.querySelector("#plansCard").textContent).toContain("1.0Mtokens this month");
  }, 20000);

  test("an app found on this computer shows beside Claude in its months, and its plan is added in place", async () => {
    const { hooks, forgetFound } = require("../src/found") as typeof import("../src/found");
    mkdirSync(join(process.env.HOME!, "Applications", "Perplexity.app"), { recursive: true });
    const was = hooks.spotlight;
    hooks.spotlight = () => ({ added: Date.parse("2026-03-02T10:00:00Z"), used: Date.parse("2026-10-20T09:00:00Z") });
    forgetFound();
    try {
      const doc = await openApp();
      await goSavings(doc);
      const t = doc.querySelector("#plansCard").textContent;
      expect(t).toContain("Perplexity app on this computer, in use since Mar 2026");
      expect(t).toContain("Add your plan");
      expect(t).not.toContain("Enter your plan"); // no log files here: its plan is picked in place
      const tile = [...doc.querySelectorAll("#plansCard .pl")].find((x: any) => x.textContent.includes("Perplexity app"));
      const pick = tile.querySelector("select[aria-label='Pick your Perplexity plan, here']");
      pick.value = "0";
      pick.dispatchEvent(new win.Event("change", { bubbles: true }));
      expect(tile.querySelector("input[aria-label='Perplexity plan name, here']").value).toBe("Perplexity Pro");
      expect(tile.querySelector("select[aria-label='Perplexity plan since, here']").value).toBe("2026-03"); // the month the app came
      press(doc, "Save", ".pl-add");
      await waitFor(() => toasts(doc).includes("Perplexity plan saved."));
      expect((await ui(url, "/api/state")).json.settings.plans.perplexity).toEqual({ name: "Perplexity Pro", price: 20, since: "2026-03" });
      await waitFor(() => !!doc.querySelector("#plansCard")?.textContent.includes("$20.00 a month"));
      expect(doc.querySelector("#plansCard").textContent).toContain("since Mar 2026");
      // a month before the plan and the app: no Perplexity tile at all
      const m = doc.querySelector("#tab-savings select[aria-label='Month']");
      m.value = "2026-02";
      m.dispatchEvent(new win.Event("change", { bubbles: true }));
      await waitFor(() => !!doc.querySelector("#plansCard .pl, #plansCard .pl-note") && !doc.querySelector("#plansCard").textContent.includes("Perplexity"));
      expect(doc.querySelector("#plansCard").textContent).not.toContain("Perplexity");
      expect(bad(doc)).toBe(false);
    } finally {
      hooks.spotlight = was;
      rmSync(join(process.env.HOME!, "Applications"), { recursive: true, force: true });
      forgetFound();
    }
  }, 30000);

  test("Settings: a plan's months, kept and shown on Savings", async () => {
    logs(line("1", "claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 0 }));
    const doc = await openApp();
    await goSettings(doc);
    set(doc.querySelector("input[aria-label='Claude plan name']"), "Claude Max 20x");
    set(doc.querySelector("input[aria-label='Claude plan price a month']"), "200");
    doc.querySelector("select[aria-label='Claude plan since']").value = "2026-07";
    press(doc, "Save", ".plan-row");
    await waitFor(() => toasts(doc).includes("Claude plan saved."));
    expect((await ui(url, "/api/state")).json.settings.plans.claude).toEqual({ name: "Claude Max 20x", price: 200, since: "2026-07" });
    expect(doc.querySelector("select[aria-label='Claude plan since']").value).toBe("2026-07");
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).toContain("$200.00 a month · since Jul 2026");
  }, 20000);

  test("Settings: a plan with a name and no price is refused with the reason, and nothing is saved", async () => {
    const doc = await openApp();
    await goSettings(doc);
    set(doc.querySelector("input[aria-label='ChatGPT plan name']"), "ChatGPT Plus");
    const row = [...doc.querySelectorAll(".plan-row")][1];
    [...row.querySelectorAll("button")].find((b: any) => b.textContent === "Save").click();
    await waitFor(() => toasts(doc).includes("price must be"));
    expect(toasts(doc)).toContain("the chatgpt plan's price must be a dollar amount");
    expect((await ui(url, "/api/state")).json.settings.plans).toEqual({});
  }, 20000);
});

describe("The Plan tab", () => {
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  const press = (doc: any, text: string, within = "body") => [...doc.querySelector(within).querySelectorAll("button")].find((b: any) => b.textContent === text)?.click();
  beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });
  const goPlan = async (doc: any) => {
    doc.querySelector('.tabs button[data-tab="plan"]').click();
    await waitFor(() => !!doc.querySelector("#tab-plan textarea"));
  };

  test("before any plan, it says how it works; an empty task asks for one", async () => {
    const doc = await openApp();
    await goPlan(doc);
    expect(doc.querySelector("#tab-plan").textContent).toContain("How it works");
    doc.querySelector("#planGo").click();
    await waitFor(() => toasts(doc).includes("Write the task first."));
    expect(toasts(doc)).toContain("Write the task first.");
  }, 20000);

  test("a task in, a table out: each part, where it runs and its model; Run runs Leanfare's parts and shows their answers", async () => {
    await keys("openai", "google", "deepseek");
    const doc = await openApp();
    await goPlan(doc);
    doc.querySelector("#tab-plan textarea[aria-label='What do you want to do?']").value = "Fix the failing tests in the parser";
    doc.querySelector("#tab-plan input[aria-label='Split by rules']").checked = true;
    doc.querySelector("#planGo").click();
    await waitFor(() => !!doc.querySelector("#planResult"));
    expect(doc.querySelectorAll("#planResult tbody tr").length).toBe(5);
    let t = doc.querySelector("#planResult").textContent;
    expect(t).toContain("you (Claude Code)");
    expect(t).toContain("go to Leanfare, keeping about");
    expect(t).toContain("Split by rules.");
    expect(t).toContain("One of Leanfare's parts waits for yours (see When)."); // part 5 reviews your changes
    expect(t).toContain("Claude Sonnet 4.6"); // the parts that stay with you name the model to pick in Claude Code
    expect(t).not.toContain("your model");
    expect(t).toContain("the ones after yours take");
    expect(doc.querySelector("#planResult tbody tr.yours")).toBeTruthy(); // the parts that stay with you are marked
    expect(doc.querySelector("#planResult td[data-label='Model']")).toBeTruthy(); // the phone shows each cell with its name
    expect(bad(doc)).toBe(false);
    press(doc, "Run Leanfare's parts", "#planResult");
    await waitFor(() => toasts(doc).includes("Leanfare's parts are done."), 20000);
    t = doc.querySelector("#planResult").textContent;
    expect(t).toContain("done");
    expect(t).toContain("yours to do");
    expect(t).toContain("after yours");
    const labels = [...doc.querySelectorAll("#planResult button")].map((b: any) => b.textContent);
    expect(labels.some((x: string) => x.startsWith("Run"))).toBe(false); // what is left waits for yours: nothing more to run here
    expect(doc.querySelectorAll("#planResult .plan-answer").length).toBeGreaterThan(0);
    expect(doc.querySelector("#planResult .plan-answer .md")).toBeTruthy();
    expect(bad(doc)).toBe(false);
    // Working in Codex instead: the same parts stay, named for Codex's models.
    const works = doc.querySelector("#tab-plan select[aria-label='Works in']");
    works.value = "Codex"; works.dispatchEvent(new win.Event("change"));
    const before = doc.querySelector("#planResult");
    doc.querySelector("#planGo").click();
    await waitFor(() => doc.querySelector("#planResult") !== before && doc.querySelector("#planResult").textContent.includes("you (Codex)"));
    t = doc.querySelector("#planResult").textContent;
    expect(t).toContain("GPT-5 mini");
    expect(t).not.toContain("Claude Sonnet 4.6");
  }, 40000);
});

describe("The plan meter", () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { forgetLogs } = require("../src/plans") as typeof import("../src/plans");
  const sl = require("../src/statusline") as typeof import("../src/statusline");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  const press = (doc: any, text: string, within = "body") => [...doc.querySelector(within).querySelectorAll("button")].find((b: any) => b.textContent === text)?.click();
  const T = (iso: string) => Date.parse(iso);
  beforeEach(async () => {
    rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
    for (const f of [sl.limitsFile(), join(process.env.LEANFARE_DATA_DIR!, "limits-last.json"), sl.meterCacheFile()]) rmSync(f, { force: true });
    process.env.LEANFARE_CLAUDE_SETTINGS = join(mkdtempSync(join(tmpdir(), "claude-settings-")), "settings.json");
    forgetLogs();
    await reset({ ticked: ALL_TICKED });
  });
  function someUse() {
    const d = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-Users-you-llmledger");
    mkdirSync(d, { recursive: true });
    const line = (id: string, ts: string, out: number) => JSON.stringify({ type: "assistant", timestamp: ts, cwd: "/Users/you/llmledger", requestId: "r" + id, message: { id: "m" + id, model: "claude-sonnet-4-6", usage: { input_tokens: 0, output_tokens: out } } });
    writeFileSync(join(d, "a.jsonl"), line("1", "2026-10-21T11:00:00Z", 2_000_000) + "\n");
    sl.saveSnap({ at: T("2026-10-21T10:00:00Z"), five: { used: 20, resets: T("2026-10-21T15:00:00Z") }, week: { used: 85, resets: T("2026-10-27T12:00:00Z") } });
    sl.saveSnap({ at: T("2026-10-21T11:30:00Z"), five: { used: 60, resets: T("2026-10-21T15:00:00Z") }, week: { used: 90, resets: T("2026-10-27T12:00:00Z") } });
    forgetLogs();
  }
  const goSavings = async (doc: any) => {
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#plansCard .meter") || (!!doc.querySelector("#plansCard") && doc.querySelector("#plansCard").textContent.includes("status line")));
  };

  test("the two windows show as bars with what is left, and what still fits", async () => {
    someUse();
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 200 } } });
    const doc = await openApp();
    await goSavings(doc);
    const t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("Right now");
    expect(t).toContain("5 hours");
    expect(t).toContain("60% used");
    expect(t).toContain("This week");
    expect(t).toContain("90% used");
    expect(t).toContain("tokens left at your recent mix");
    expect(t).not.toContain("of work"); // dollars of work only when Settings shows them
    expect(t).toContain("a starting estimate");
    expect(t).toContain("What still fits");
    expect(t).toContain("llmledger: about");
    expect(t).toMatch(/a session is (about [\d.]+%|under 0\.1%) of the week/);
    expect(t).not.toContain("0.0%"); // a small session reads "under 0.1%", never nothing
    expect(doc.querySelector("#plansCard .meter .track.hot i")).toBeTruthy(); // the week at 90% is coloured
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("with the value shown (Settings), the meter also gives the work left in dollars at API prices", async () => {
    someUse();
    await ui(url, "/api/settings", { plans: { claude: { name: "Claude Max", price: 200 } }, showValue: true });
    const doc = await openApp();
    await goSavings(doc);
    const t = doc.querySelector("#plansCard").textContent;
    expect(t).toContain("tokens left at your recent mix");
    expect(t).toMatch(/about \$[\d,.]+ of work at API prices/);
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("Add to the status line writes Claude Code's settings, is its own Stop while it works, and can be undone", async () => {
    const doc = await openApp();
    await goSavings(doc);
    expect(doc.querySelector("#plansCard").textContent).toContain("never your words");
    press(doc, "Add to the status line", "#plansCard");
    await waitFor(() => toasts(doc).includes("Added."));
    expect(JSON.parse(readFileSync(process.env.LEANFARE_CLAUDE_SETTINGS!, "utf8")).statusLine.command).toContain("statusline");
    expect(doc.querySelector("#plansCard").textContent).toContain("come from Claude Code's status line");
    press(doc, "Remove from the status line", "#plansCard");
    await waitFor(() => toasts(doc).includes("Removed"));
    expect(JSON.parse(readFileSync(process.env.LEANFARE_CLAUDE_SETTINGS!, "utf8")).statusLine).toBeUndefined();
    expect(bad(doc)).toBe(false);
  }, 20000);
});

describe("What Leanfare did for your apps (Savings)", () => {
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  const goSavings = async (doc: any) => {
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#tab-savings .sv-head"));
  };
  const LOG = { name: "app.log", text: "10:00 start\n10:01 error: disk full\n" };
  beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

  test("no card until something is handed over; then what stayed out, the cost, the grades and the checks, and the last few", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    let doc = await openApp();
    await goSavings(doc);
    expect(doc.querySelector("#workCard")).toBeNull();
    closeApp();
    const one = await ui(url, "/api/delegate", { task: "Summarize. [reply@google PASS]", files: [LOG], kind: "read", effort: "low", check: "always" });
    await ui(url, "/api/delegate", { task: "Find the errors. [reply@google FAIL: misses one]", files: [LOG], kind: "read", effort: "low", check: "always" });
    doc = await openApp();
    await goSavings(doc);
    const card = doc.querySelector("#workCard");
    // At the top of Savings, before the subscriptions.
    expect(card.previousElementSibling.className).toBe("sv-head");
    const t = card.textContent;
    expect(t).toContain("What Leanfare did for your apps");
    expect(t).toContain("2 tasks this month, through plan and delegate");
    expect(t).toMatch(/Kept out of your plans\S*\d+%18 tokens stayed out · \d+ came back/);
    expect(t).toContain("Cost of that work");
    expect(t).toContain("2 paid");
    expect(t).toContain("QualityiNot graded yet");
    expect(t).toContain("1 of 2 passed1 was asked again one tier up");
    expect(t).toMatch(/Checks: 2 run, 1 passed \(50%, 90% range 12% to 88%\), 1 failed and was asked again one tier up\./);
    expect(t).not.toContain("Weighted"); // shown from five checks on
    const rows = [...card.querySelectorAll(".work-table tbody tr")].map((r: any) => [...r.querySelectorAll("td")].map((c: any) => c.textContent));
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toMatch(/^(Today \d|Yesterday \d|[A-Z][a-z]{2} \d{1,2}$|\d{1,2} [A-Z][a-z]{2}$)/); // the tests' clock is not the page's
    expect(rows[0][1]).toBe("Hand off: reading · 1 file");
    expect(rows[0][2]).toMatch(/^paid: /);
    expect(rows[0][5]).toBe("check failed");
    expect(rows[1][5]).toBe("check passed");
    const by = doc.querySelector("#tab-savings .sv-grid h3 small").textContent;
    expect(by).toContain("Delegated: 3");
    expect(by).toContain("Checks: 2");
    expect(bad(doc)).toBe(false);
    // The first one graded good by the app that asked, with its handoff: the quality and its chip.
    closeApp();
    const g = await ui(url, "/api/grades", { model: one.json.model.id, kind: "read", verdict: "good", handoff: one.json.row });
    expect(g.status).toBe(200);
    doc = await openApp();
    await goSavings(doc);
    const after = doc.querySelector("#workCard");
    expect(after.textContent).toContain("1 of 1 good0 partly · 0 wrong · graded by your apps");
    expect(after.querySelector(".work-table tbody tr:last-child td:last-child").textContent).toBe("good");
    // What a number means, a press away.
    const info = [...after.querySelectorAll(".stat .lbl button")].find((b: any) => b.getAttribute("aria-label") === 'What "Kept out of your plans" means') as any;
    info.click();
    expect(doc.querySelector("#workCard .def").textContent).toContain("the least it kept out");
    expect(bad(doc)).toBe(false);
  }, 20000);
});

describe("Setting up with no typing (Settings)", () => {
  const { SHAPED } = require("./fake") as typeof import("./fake");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  const set = (el: any, v: string) => { el.value = v; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const press = (doc: any, text: string, within = "body") => [...doc.querySelector(within).querySelectorAll("button")].find((b: any) => b.textContent === text)?.click();
  const goSettings = async (doc: any) => {
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector("input[aria-label='Any API key']"));
  };
  beforeEach(async () => { await reset({ ticked: ALL_TICKED, custom: [] }); });

  test("Paste any key: Leanfare says whose it is, saves it, and the provider moves up from More providers", async () => {
    const doc = await openApp();
    await goSettings(doc);
    const names = () => [...doc.querySelectorAll(".colL > .prov .prov-head .name")].map((n: any) => n.textContent);
    expect(names().some((n: string) => n.startsWith("More providers (Perplexity, Groq"))).toBe(true);
    expect(names()).not.toContain("Perplexity");
    set(doc.querySelector("input[aria-label='Any API key']"), SHAPED.perplexity);
    press(doc, "Add key", ".keys-any");
    await waitFor(() => toasts(doc).includes("A Perplexity key."));
    expect(toasts(doc)).toContain("Saved in");
    expect(names()).toContain("Perplexity"); // it has a key now, so it is listed with the others
    expect(doc.querySelector("input[aria-label='Any API key']").value).toBe("");
    expect(doc.body.textContent).not.toContain(SHAPED.perplexity.slice(0, 20));
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("an unknown key opens Add a provider, with the reason", async () => {
    const doc = await openApp();
    await goSettings(doc);
    set(doc.querySelector("input[aria-label='Any API key']"), "zzzz-unknown-key-1234567");
    press(doc, "Add key", ".keys-any");
    await waitFor(() => toasts(doc).includes("does not recognize"));
    await waitFor(() => !!doc.querySelector("input[aria-label='Provider address']"));
    expect(doc.querySelector("input[aria-label='Provider address']")).toBeTruthy();
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("Find my keys lists what it found with the last four characters only, and nothing when there is nothing", async () => {
    const doc = await openApp();
    await goSettings(doc);
    press(doc, "Find my keys", ".keys-any");
    await waitFor(() => !!doc.querySelector(".found"));
    expect(doc.querySelector(".found").textContent).toMatch(/No keys found|Found on this computer/);
    expect(doc.querySelector(".found").textContent).not.toMatch(/sk-proj-|pplx-[a-z0-9]{8}/);
    press(doc, "Close", ".found");
    await waitFor(() => !doc.querySelector(".found"));
    expect(bad(doc)).toBe(false);
  }, 20000);
});

describe("Use Leanfare in your apps (Settings)", () => {
  const { mkdirSync, mkdtempSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  const realHome = process.env.HOME;
  afterEach(() => { process.env.HOME = realHome; });

  test("the apps on this computer are listed with Add; Add writes the app's settings and turns into Remove", async () => {
    const home = mkdtempSync(join(tmpdir(), "leanfare-apps-screen-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector(".apps .app-row"));
    const row = () => [...doc.querySelectorAll(".apps .app-row")].find((r: any) => r.textContent.includes("Cursor")) as any;
    expect(row().textContent).toContain("not added yet");
    [...row().querySelectorAll("button")].find((b: any) => b.textContent === "Add").click();
    await waitFor(() => toasts(doc).includes("Added Leanfare's tools to Cursor."));
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.leanfare.args.at(-1)).toBe("mcp");
    await waitFor(() => row().textContent.includes("added") && !row().textContent.includes("not added"));
    expect([...row().querySelectorAll("button")].map((b: any) => b.textContent)).toContain("Remove");
    expect(doc.querySelector(".apps").textContent).toContain("more not found on this computer");
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("once Leanfare's tools are in Codex, Plan by itself is one press: a line in AGENTS.md, and the press undoes it", async () => {
    const codex = process.env.CODEX_HOME!;
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(codex, { recursive: true, force: true });
    mkdirSync(codex, { recursive: true });
    expect((await ui(url, "/api/apps", { id: "codex", on: true })).status).toBe(200);
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector(".apps .auto-row"));
    const row = () => [...doc.querySelectorAll(".apps .app-row")].find((r: any) => r.textContent.includes("Codex CLI")) as any;
    expect(row().querySelector(".auto-row").textContent).toContain("Plan by itself: a line in AGENTS.md");
    [...row().querySelectorAll(".auto-row button")].find((b: any) => b.textContent === "Turn on").click();
    await waitFor(() => toasts(doc).includes("Codex CLI now plans by itself with Leanfare."));
    expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toContain("call Leanfare's plan tool first");
    await waitFor(() => !!row()?.querySelector(".auto-row button") && row().querySelector(".auto-row button").textContent === "Turn off");
    row().querySelector(".auto-row button").click();
    await waitFor(() => toasts(doc).includes("no longer plans with Leanfare by itself"));
    expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toBe("");
    await ui(url, "/api/apps", { id: "codex", on: false });
    expect(bad(doc)).toBe(false);
  }, 30000);
});

describe("Plan by itself for tools another copy of Leanfare added", () => {
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  test("the Plan by itself line shows for them too", async () => {
    const { mkdirSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const codex = process.env.CODEX_HOME!;
    rmSync(codex, { recursive: true, force: true });
    mkdirSync(codex, { recursive: true });
    const { join } = require("node:path") as typeof import("node:path");
    writeFileSync(join(codex, "config.toml"), `[mcp_servers.leanfare]\ncommand = "/old/bun"\nargs = ["mcp"]\n`); // put there by another copy (the Mac app's, say)
    await reset({ ticked: ALL_TICKED });
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    const row = () => [...doc.querySelectorAll(".apps .app-row")].find((r: any) => r.textContent.includes("Codex CLI")) as any;
    await waitFor(() => !!row()?.querySelector(".auto-row"));
    expect(row().textContent).toContain("added from another copy of Leanfare");
    expect(row().querySelector(".auto-row").textContent).toContain("Plan by itself: a line in AGENTS.md");
    rmSync(codex, { recursive: true, force: true });
  }, 20000);
});

describe("Subscriptions on Savings and in Settings", () => {
  const { mkdirSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { forgetLogs } = require("../src/plans") as typeof import("../src/plans");
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  beforeEach(async () => {
    rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
    forgetLogs();
    await reset({ ticked: ALL_TICKED });
  });

  test("the plan Codex names is offered with Use this plan; pressing it saves the plan", async () => {
    const d = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "20");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "rollout-x.jsonl"), [
      JSON.stringify({ timestamp: "2026-10-20T13:05:15Z", type: "turn_context", payload: { model: "gpt-5-mini" } }),
      JSON.stringify({ timestamp: "2026-10-21T11:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1792600000 }, plan_type: "plus" } } }),
    ].join("\n") + "\n");
    forgetLogs();
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    await waitFor(() => !!doc.querySelector("#plansCard") && doc.querySelector("#plansCard").textContent.includes("Codex says you are on this plan"));
    const card = doc.querySelector("#plansCard");
    expect(card.textContent).toContain("ChatGPT Plus");
    expect(doc.querySelector("#tab-savings").textContent).toContain("Pay per use: what your keys and credits spent through Leanfare");
    [...card.querySelectorAll("button")].find((b: any) => b.textContent === "Use this plan").click();
    await waitFor(() => toasts(doc).includes("ChatGPT plan saved."));
    expect((await ui(url, "/api/state")).json.settings.plans.chatgpt).toEqual({ name: "ChatGPT Plus", price: 20 });
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("Settings: picking a plan fills its name and price; more subscriptions are one press away", async () => {
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector("select[aria-label='Pick your Claude plan']"));
    const pick = doc.querySelector("select[aria-label='Pick your Claude plan']");
    pick.value = "2";
    pick.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(doc.querySelector("input[aria-label='Claude plan name']").value).toBe("Claude Max 20x");
    expect(doc.querySelector("input[aria-label='Claude plan price a month']").value).toBe("200");
    expect(doc.querySelector("select[aria-label='Pick your Perplexity plan']")).toBeNull();
    [...doc.querySelectorAll("button")].find((b: any) => b.textContent.startsWith("▸ More subscriptions")).click();
    await waitFor(() => !!doc.querySelector("select[aria-label='Pick your Perplexity plan']"));
    expect(doc.querySelector("select[aria-label='Pick your Perplexity plan']").textContent).toContain("Perplexity Pro · $20.00");
    expect(bad(doc)).toBe(false);
  }, 20000);
});

describe("Speed: in Settings and beside the message box", () => {
  const toasts = (doc: any) => [...doc.querySelectorAll("#toasts .toast")].map((t: any) => t.textContent).join(" | ");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function waitFor(ok: () => boolean, ms = 8000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

  test("Settings saves your speed; the message box shows the same choice, its time, and hides it for a model you picked", async () => {
    await keys("anthropic", "google", "xai");
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    await waitFor(() => !!doc.querySelector(".setting select[aria-label='Speed']"));
    const sel = doc.querySelector(".setting select[aria-label='Speed']");
    expect(sel.value).toBe("cheapest");
    expect([...sel.options].map((o: any) => o.textContent)).toEqual(["The cheapest, however long it takes", "The cheapest within about a minute", "The cheapest within about 20 seconds", "The cheapest within about 5 seconds", "The fastest, whatever it costs"]);
    sel.value = "fastest";
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => toasts(doc).includes("Speed: the fastest, whatever it costs."));
    expect((await ui(url, "/api/state")).json.settings.speed).toBe("fastest");

    doc.querySelector('.tabs button[data-tab="chat"]').click();
    const box = () => doc.querySelector(".composer select.speed");
    await waitFor(() => box()?.value === "fastest");
    expect(box().value).toBe("fastest");
    expect(box().hidden).toBe(false);
    type(doc.querySelector("textarea"), "What is the capital of Australia?");
    const est = () => doc.querySelector(".composer .est").textContent;
    await waitFor(() => /about (a second|\d+ s)/.test(est()));
    expect(est()).toMatch(/^≈ \$[\d.]+ · about (a second|\d+ s) \(a guess\) on /); // no answers here yet: a rough guess, said so
    box().value = "20";
    box().dispatchEvent(new win.Event("change", { bubbles: true }));
    await waitFor(() => toasts(doc).includes("Speed: within 20 s."));
    expect((await ui(url, "/api/state")).json.settings.speed).toBe(20);
    choose(doc, "google/gemini-3.8-flash");
    await waitFor(() => box().hidden === true);
    expect(box().hidden).toBe(true); // speed is how Auto picks; a model you chose is that model
    expect(bad(doc)).toBe(false);
  }, 20000);

  test("an answer's details say its expected time and the cheapest and fastest at the same quality", async () => {
    await keys("anthropic", "google", "xai");
    const { db } = require("../src/db") as typeof import("../src/db");
    const { forgetSpeeds } = require("../src/speed") as typeof import("../src/speed");
    const row = db.query(`INSERT INTO ledger(ts, month, day, source, provider, model, price_status, usage_status, status, ms, first_ms, out_tokens)
      VALUES ('2026-10-21T11:00:00Z', '2026-10', '2026-10-21', 'chat', ?, ?, 'listed', 'reported', 'ok', ?, ?, 400)`);
    for (let i = 0; i < 3; i++) { row.run("google", "google/gemini-3.8-flash", 700, 300); row.run("xai", "xai/grok-4.20-beta", 29_000, 9_000); }
    forgetSpeeds();
    const doc = await openApp();
    const ta = doc.querySelector("textarea");
    type(ta, "What is the capital of Australia?");
    await waitFor(() => doc.querySelector(".composer .est").textContent.includes("faster: Gemini 3.8 Flash"));
    expect(doc.querySelector(".composer .est").textContent).toMatch(/on Grok 4\.20 Beta .* · faster: Gemini 3\.8 Flash ≈ \$[\d.]+, about a second$/);
    key(ta, "Enter");
    await waitIdle(doc);
    await waitFor(() => !![...doc.querySelectorAll("button")].find((b: any) => b.textContent === "Why this model"));
    [...doc.querySelectorAll("button")].find((b: any) => b.textContent === "Why this model").click();
    await waitFor(() => doc.body.textContent.includes("At the same quality"));
    expect(doc.body.textContent).toContain("Speed: expected about 29 s, from this model's answers here. At the same quality: cheapest Grok 4.20 Beta ≈ $");
    expect(doc.body.textContent).toMatch(/fastest Gemini 3\.8 Flash ≈ \$[\d.]+, about a second\./);
    expect(bad(doc)).toBe(false);
  }, 20000);
});

describe("The delegate trial on Savings", () => {
  const { QUESTIONS, REPO_ISSUES, timing, truths } = require("../src/trial") as typeof import("../src/trial");
  const bad = (doc: any) => /\bnull\b|\bundefined\b|NaN|\[object Object\]/.test(doc.body.textContent);
  async function waitFor(ok: () => boolean, ms = 15000) { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); }
  beforeEach(async () => { await reset({ ticked: ALL_TICKED }); timing.pause = 0; });
  afterEach(() => { timing.pause = 2000; });

  test("Run the trial: its estimate first, then the table, the verdict, the line to copy and Share", async () => {
    await keys("openai", "anthropic", "google", "deepseek", "xai", "mistral");
    const T = truths();
    fake.hooks.answer = (prompt, provider) => {
      const i = QUESTIONS.findIndex((q) => prompt.includes(q.task));
      if (i < 0 || prompt.includes("You check another model's work")) return prompt.includes("You check another model's work") ? "PASS" : null;
      if (provider === "deepseek" && QUESTIONS[i].id === "csv-refunds") return "2400.00";
      return Array.isArray(T[i]) ? (T[i] as string[]).join(", ") : String(T[i]);
    };
    const doc = await openApp();
    doc.querySelector('.tabs button[data-tab="savings"]').click();
    const card = () => doc.querySelector("#trialCard");
    await waitFor(() => !!card() && card().textContent.includes("Run the trial"));
    expect(card().textContent).toContain("Try the delegate first");
    expect(card().textContent).toMatch(/About \$[\d.]+ on the models you ticked now, about \d+ min: low DeepSeek V4 Flash, medium Gemini 3\.8 Flash, high Gemini 3\.8 Flash\./);
    [...card().querySelectorAll("button")].find((b: any) => b.textContent === "Run the trial").click();
    await waitFor(() => !!card()?.querySelector(".trial-verdict"));
    expect(card().textContent).toContain("Low effort passes (at most one miss): Claude can hand reading work to Leanfare at effort low.");
    expect(card().querySelector(".trial-verdict code").textContent).toBe("To read large files or logs, use the leanfare delegate tool with effort low, and work from its answer.");
    const cells = [...card().querySelectorAll(".trial-table tbody tr")].map((tr: any) => [...tr.querySelectorAll("td")].map((td: any) => td.textContent));
    expect(cells.map((c) => [c[0], c[1], c[5]])).toEqual([["low, no check", "9 of 10", "passes"], ["medium, no check", "10 of 10", "passes"], ["high, checked", "10 of 10", "passes"]]);
    expect(card().textContent).toContain("Wrong answers (1)");
    const share = [...card().querySelectorAll("a")].find((a: any) => a.textContent === "Share on GitHub");
    expect(share.getAttribute("href")).toStartWith(`${REPO_ISSUES}?title=`);
    expect(share.getAttribute("target")).toBe("_blank");
    expect([...card().querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(expect.arrayContaining(["Copy the line", "Copy the results", "Run again"]));
    await waitFor(() => doc.querySelector("#tab-savings").textContent.includes("Trial: 30")); // Savings reloads just after the verdict shows
    expect(doc.querySelector("#tab-savings").textContent).toContain("Trial: 30"); // the ledger's sources, under By model
    expect(bad(doc)).toBe(false);
  }, 30000);
});
