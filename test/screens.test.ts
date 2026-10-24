// The screens as you use them: the real ui/app.js in happy-dom (a browser
// without a screen), against the real test server.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ALL_TICKED, boot, keys, ledger, reset, ui } from "./app";
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
