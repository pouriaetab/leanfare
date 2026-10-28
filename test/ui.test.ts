// Rules for the screens that can be checked in the source.
import { expect, test } from "bun:test";

const js = await Bun.file(new URL("../ui/app.js", import.meta.url)).text();
const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();

test("every button that starts work is a run button, so it turns into its own Stop", () => {
  const plain = [...js.matchAll(/h\("button",\s*\{[^}]*text:\s*"(Test and save|Update now|Update list|Look again|Refresh)"/g)];
  expect(plain.map((m) => m[1])).toEqual([]);
  for (const label of ["Test and save", "Update now", "Update list", "Look again", "Refresh"]) expect(js).toContain(`runButton("${label}"`);
});
test("Turn on Leanfare is a run button too, so it is its own Stop", () => {
  expect(js).toContain('runButton(allIn ? "Turn on Leanfare again" : "Turn on Leanfare", (signal) => turnOnLeanfare(signal), "btn primary big-btn")');
});
test("Send becomes Stop while an answer is written, and Esc stops it", () => {
  expect(js).toContain('send.textContent = S.live ? "Stop" : "Send"');
  expect(js).toContain('e.key === "Escape" && S.live');
});
test("a stopped or failed answer offers Start again or Try again", () => {
  expect(js).toContain('text: "Start again", onclick: () => startAgain(index)');
  expect(js).toContain('text: "Try again", onclick: () => startAgain(index)');
});
test("removals can be undone", () => {
  expect(js).toMatch(/Removed "\$\{c\.title\}"\.`, "done", \{ action: \{ label: "Undo"/);
  expect(js).toContain('label: "Undo", run: async () => { try { const x = await api(`/api/keys/${p.id}/restore`');
});
test("a model's text only reaches the page through the escaping markdown renderer", () => {
  const sets = [...js.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  expect(sets.sort()).toEqual(["markdown(m.content)", "markdown(r.answer)"]); // a chat answer, and a plan part's answer
});
test("drafts are kept in localStorage", () => {
  expect(js).toContain("localStorage.setItem");
  expect(js).not.toContain("sessionStorage");
});
test("the page loads nothing from the internet", () => {
  expect(html).not.toMatch(/(src|href)="https?:/);
  expect(js).not.toMatch(/fetch\(\s*["'`]https?:/);
});

test("the page starts simple, and shows no screen before the script picks one", () => {
  expect(html).toContain('<div id="app" class="simple">');
  expect(html).not.toMatch(/class="tab[^"]*\bon\b/);
});
