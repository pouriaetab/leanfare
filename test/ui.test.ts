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

// Day, Auto and Night: every color is a token that both themes define.
const css = await Bun.file(new URL("../ui/app.css", import.meta.url)).text();
const themeJs = await Bun.file(new URL("../ui/theme.js", import.meta.url)).text();
test("every color in the styles is a token, and Night defines every color Day does", () => {
  const day = /^:root \{([^}]*)\}/m.exec(css)![1];
  const nights = [/:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/.exec(css)![1], /:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)![1]];
  const colorNames = [...day.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi)].map((m) => m[1]);
  expect(colorNames.length).toBeGreaterThan(15);
  for (const night of nights) expect(colorNames.filter((n) => !night.includes(n + ":"))).toEqual([]);
  // Outside the token blocks, no light color is written straight into a rule.
  const rest = css.replace(/^:root \{[^}]*\}/m, "").replace(/:root:not\(\[data-theme="light"\]\) \{[^}]*\}/, "").replace(/:root\[data-theme="dark"\] \{[^}]*\}/, "");
  const light = (c: string) => {
    const hex = /^#([0-9a-f]{3,8})$/i.exec(c);
    const rgb = hex ? (hex[1].length <= 4 ? [...hex[1].slice(0, 3)].map((x) => parseInt(x + x, 16)) : [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)))
      : (/rgba?\(([^)]*)\)/.exec(c)![1].split(",").slice(0, 3).map((x) => parseFloat(x)));
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.5;
  };
  const written = [...rest.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map((m) => m[0]);
  expect(written.filter(light)).toEqual([]);
  expect(rest).not.toMatch(/:\s*white\b/);
  // And no color set from the script either (the page sets sizes there, never colors).
  expect([...js.matchAll(/style:\s*\{([^}]*)\}/g)].filter((m) => /color|background/i.test(m[1]))).toEqual([]);
});
test("the page starts simple, shows no screen before the script picks one, and sets the theme before it is drawn", () => {
  expect(html).toContain('<div id="app" class="simple">');
  expect(html).not.toMatch(/class="tab[^"]*\bon\b/);
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head.indexOf('<script src="/theme.js"></script>')).toBeGreaterThan(-1);
  expect(head.indexOf('<script src="/theme.js"></script>')).toBeLessThan(head.indexOf('<script src="/app.js" defer></script>'));
});
test("theme.js: the kept choice, or Auto by the clock (day from 7 AM to 7 PM)", () => {
  const run = (kept: string | null, hour: number) => {
    const attrs: Record<string, string> = {};
    const doc = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
    const storage = { getItem: (k: string) => (k === "leanfare.theme" ? kept : null) };
    class At { getHours() { return hour; } }
    new Function("localStorage", "document", "Date", themeJs)(storage, doc, At);
    return attrs["data-theme"];
  };
  expect(run('"dark"', 12)).toBe("dark");
  expect(run('"light"', 23)).toBe("light");
  expect(run('"auto"', 7)).toBe("light");
  expect(run('"auto"', 18)).toBe("light");
  expect(run('"auto"', 19)).toBe("dark");
  expect(run(null, 6)).toBe("dark");
  expect(run("not json", 12)).toBe("light");
});
