// The real ui/app.js, run in happy-dom (a browser without a screen) against the
// real test server. Shared by the screen tests.
import { Window } from "happy-dom";

export const appJs = await Bun.file(new URL("../ui/app.js", import.meta.url)).text();
const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();
export let win: any = null;

// One page at a time, and a closed page stays quiet: a page left open kept asking the server every
// few seconds (on Settings it asks what Ollama has), and those requests landed in later tests' counts.
// The page leaves win at once, so a close that ends late never closes the next test's page.
export async function closeApp() {
  const w = win;
  win = null;
  try { await w?.happyDOM?.abort(); } catch {} // ends the page's timers (window.close() does not)
}

export async function openApp(url: string) {
  await closeApp();
  const w: any = new Window({ url: url + "/", width: 1440, height: 800 });
  win = w;
  const doc = w.document;
  doc.write(html.replace(/<script[^>]*><\/script>/, ""));
  // A closed page sends nothing more: its next request never leaves, and nothing waits on it.
  const f = (path: string, opts: any = {}) => (win === w ? fetch(new URL(path, url), opts) : new Promise<Response>(() => {}));
  const run = new Function("window", "document", "localStorage", "fetch", "matchMedia", "requestAnimationFrame", "navigator", "location", "Event", "AbortController", "TextDecoder", "Element", "DocumentFragment", "Node", "setTimeout", "setInterval", "clearTimeout", appJs);
  run(win, doc, win.localStorage, f, win.matchMedia.bind(win), (cb: any) => setTimeout(() => cb(Date.now()), 16), win.navigator, win.location, win.Event, AbortController, TextDecoder, win.Element, win.DocumentFragment, win.Node, win.setTimeout.bind(win), win.setInterval.bind(win), win.clearTimeout.bind(win));
  for (let i = 0; i < 100 && !doc.querySelector("textarea"); i++) await Bun.sleep(30);
  await Bun.sleep(300);
  return doc;
}

export const key = (el: any, k: string) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
export const type = (ta: any, text: string) => { ta.value = text; ta.dispatchEvent(new win.Event("input", { bubbles: true })); };
export const choose = (doc: any, model: string) => { const pick = doc.querySelector("select[aria-label=Model]"); pick.value = model; pick.dispatchEvent(new win.Event("change")); };
export const waitIdle = async (doc: any) => { for (let i = 0; i < 100 && doc.querySelector("button.send").textContent === "Stop"; i++) await Bun.sleep(100); };
