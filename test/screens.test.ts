// The screens as you use them: the real ui/app.js in happy-dom (a browser
// without a screen), against the real test server.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { ALL_TICKED, boot, keys, ledger, reset, ui } from "./app";
import { refreshOllama } from "../src/data";

let url = "";
beforeAll(async () => { url = (await boot()).url; });

const appJs = await Bun.file(new URL("../ui/app.js", import.meta.url)).text();
const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();
let win: any = null;
afterEach(async () => { try { await win?.happyDOM?.abort(); win?.close(); } catch {} win = null; });

async function openApp() {
  win = new Window({ url: url + "/", width: 1440, height: 800 });
  const doc = win.document;
  doc.write(html.replace(/<script[^>]*><\/script>/, ""));
  const f = (path: string, opts: any = {}) => fetch(new URL(path, url), opts);
  const run = new Function("window", "document", "localStorage", "fetch", "matchMedia", "requestAnimationFrame", "navigator", "location", "Event", "AbortController", "TextDecoder", "Element", "DocumentFragment", "Node", "setTimeout", "setInterval", "clearTimeout", appJs);
  run(win, doc, win.localStorage, f, win.matchMedia.bind(win), (cb: any) => setTimeout(() => cb(Date.now()), 16), win.navigator, win.location, win.Event, AbortController, TextDecoder, win.Element, win.DocumentFragment, win.Node, win.setTimeout.bind(win), win.setInterval.bind(win), win.clearTimeout.bind(win));
  for (let i = 0; i < 100 && !doc.querySelector("textarea"); i++) await Bun.sleep(30);
  await Bun.sleep(300);
  return doc;
}
const key = (el: any, k: string) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const type = (ta: any, text: string) => { ta.value = text; ta.dispatchEvent(new win.Event("input", { bubbles: true })); };
const choose = (doc: any, model: string) => { const pick = doc.querySelector("select[aria-label=Model]"); pick.value = model; pick.dispatchEvent(new win.Event("change")); };
const waitIdle = async (doc: any) => { for (let i = 0; i < 100 && doc.querySelector("button.send").textContent === "Stop"; i++) await Bun.sleep(100); };

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
    await Bun.sleep(400);
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
