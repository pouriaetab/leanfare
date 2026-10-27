// Checks that everything Leanfare uses from others is open for business use,
// with no paid licence needed. Run it before every release.
//   bun scripts/licences.ts            packages and data sources (needs the internet)
//   bun scripts/licences.ts --offline  packages and the shipped catalogue only
// Exit code 1 if anything is not open. If a source changes its licence: stop
// using it, find an open replacement, and say so in the release notes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUGGESTED } from "../src/local";

const root = fileURLToPath(new URL("..", import.meta.url));
const OPEN = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0", "Unlicense", "BlueOak-1.0.0"]);
const offline = process.argv.includes("--offline");
const rows: { what: string; needs: string; found: string; ok: boolean }[] = [];
const add = (what: string, needs: string, found: string, ok: boolean) => rows.push({ what, needs, found, ok });

// 1. Packages: none at run time; the type checker and its types for development.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtime = Object.keys(pkg.dependencies ?? {});
add("run-time packages", "none, or open licences", runtime.length ? runtime.join(", ") : "none", runtime.length === 0);
const nm = join(root, "node_modules");
if (existsSync(nm)) {
  const dirs: string[] = [];
  for (const d of readdirSync(nm)) {
    if (d.startsWith(".")) continue;
    if (d.startsWith("@")) for (const s of readdirSync(join(nm, d))) dirs.push(join(nm, d, s));
    else dirs.push(join(nm, d));
  }
  for (const d of dirs) {
    const f = join(d, "package.json");
    if (!existsSync(f)) continue;
    const p = JSON.parse(readFileSync(f, "utf8"));
    const lic = typeof p.license === "string" ? p.license : p.license?.type ?? "none stated";
    add(`package ${p.name}@${p.version}`, "open licence", lic, OPEN.has(lic));
  }
} else add("installed packages", "open licences", "not installed (run bun install)", true);

// 2. The catalogue shipped inside this release.
const cat = JSON.parse(readFileSync(join(root, "data/catalog.json"), "utf8"));
add("shipped prices (LiteLLM via llmledger)", "MIT", cat.credits?.prices ?? "missing", /\(MIT\)/.test(cat.credits?.prices ?? ""));
add("shipped ratings (Arena)", "CC BY 4.0", cat.credits?.ratings ?? "missing", /CC BY 4\.0/.test(cat.credits?.ratings ?? ""));

// 3. The sources as they stand today.
async function text(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
async function check(what: string, needs: string, url: string, test: (t: string) => string | null) {
  try {
    const found = test(await text(url));
    add(what, needs, found ?? "not found", found !== null);
  } catch (e: any) {
    add(what, needs, `could not read ${url}: ${e?.message ?? e}`, false);
  }
}
if (!offline) {
  await check("llmledger (the data)", "MIT", "https://raw.githubusercontent.com/pouriaetab/llmledger/main/LICENSE", (t) => (/^MIT License/m.test(t) ? "MIT" : null));
  await check("llmledger's credits today", "MIT prices, CC BY 4.0 ratings", "https://pouriaetab.github.io/llmledger/data.json", (t) => {
    const c = JSON.parse(t).credits ?? {};
    return /\(MIT\)/.test(c.prices ?? "") && /CC BY 4\.0/.test(c.ratings ?? "") ? `${c.prices}; ${c.ratings}` : null;
  });
  await check("LiteLLM price list", "MIT (outside enterprise/)", "https://raw.githubusercontent.com/BerriAI/litellm/main/LICENSE", (t) =>
    /MIT License/.test(t) && /enterprise\//.test(t) ? "MIT outside enterprise/; the price list is at the top level" : /^MIT License/m.test(t) ? "MIT" : null);
  await check("Arena leaderboard dataset", "cc-by-4.0", "https://huggingface.co/api/datasets/lmarena-ai/leaderboard-dataset", (t) => {
    const lic = JSON.parse(t).cardData?.license;
    return lic === "cc-by-4.0" ? "cc-by-4.0" : null;
  });
  await check("Bun (inside the one-file builds)", "MIT, with its LGPL-2 JavaScriptCore notice shipped", "https://raw.githubusercontent.com/oven-sh/bun/main/LICENSE.md", (t) =>
    /Bun itself is MIT-licensed/.test(t) && /LGPL/.test(t) ? "MIT; it links JavaScriptCore (LGPL-2), whose notice and source link go in every archive (licenses/bun.md)" : null);
  await check("models.dev (prices of providers you add)", "MIT", "https://raw.githubusercontent.com/sst/models.dev/dev/LICENSE", (t) => (/^MIT License/m.test(t) ? "MIT" : null));
  await check("gitleaks (key shapes for Paste any key)", "MIT", "https://raw.githubusercontent.com/gitleaks/gitleaks/master/LICENSE", (t) => (/^MIT License/m.test(t) ? "MIT" : null));
  await check("betterleaks (key shapes for Paste any key)", "MIT", "https://raw.githubusercontent.com/betterleaks/betterleaks/main/LICENSE", (t) => (/^MIT License/m.test(t) ? "MIT" : null));
  // Not shipped, but Leanfare works with them: Ollama runs the local models, Codex runs plan parts on a ChatGPT plan.
  await check("Ollama (runs the local models)", "MIT", "https://raw.githubusercontent.com/ollama/ollama/main/LICENSE", (t) => (/^MIT License/m.test(t) ? "MIT" : null));
  await check("Codex CLI (runs plan parts on your ChatGPT plan)", "Apache-2.0", "https://raw.githubusercontent.com/openai/codex/main/LICENSE", (t) => (/Apache License\s+Version 2\.0/.test(t) ? "Apache-2.0" : null));
  // The open models Leanfare suggests downloading (src/local.ts): each maker's own copy must be Apache 2.0.
  for (const m of SUGGESTED) await check(`suggested model ${m.name} (${m.source})`, "apache-2.0", `https://huggingface.co/api/models/${m.source}`, (t) => {
    const lic = JSON.parse(t).cardData?.license;
    return lic === "apache-2.0" ? "apache-2.0" : null;
  });
}
// Bun's notice travels with Leanfare (scripts/compile.ts puts it in every archive).
const bunNotice = existsSync(join(root, "licenses/bun.md")) ? readFileSync(join(root, "licenses/bun.md"), "utf8") : "";
add("Bun's notice for the one-file builds", "licenses/bun.md with the LGPL-2 terms and the JavaScriptCore source", bunNotice ? "present" : "missing", /LGPL/.test(bunNotice) && /oven-sh\/webkit/i.test(bunNotice));
add("OpenRouter model list", "read at run time only", "fetched on your computer for your own costs; not shipped in releases", true);
for (const m of SUGGESTED) if (!/^[\w.-]+\/[\w.-]+$/.test(m.source)) add(`suggested model ${m.name}`, "the maker's copy named, to check its licence", m.source || "none", false);

const w = Math.max(...rows.map((r) => r.what.length));
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.what.padEnd(w)}  needs ${r.needs}; found ${r.found}`);
const bad = rows.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} source(s) are not open for business use.` : `\nAll ${rows.length} checks passed.`);
process.exit(bad.length ? 1 : 0);
