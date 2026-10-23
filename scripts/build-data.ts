// Builds data/catalog.json, the copy of the model catalogue that ships with a
// release, from llmledger's data.json.
//   bun scripts/build-data.ts                 download today's data.json
//   bun scripts/build-data.ts path/to/data.json
import { writeFileSync } from "node:fs";
import { buildCatalog } from "../src/data";

const src = process.argv[2] ?? process.env.LEANFARE_DATA_URL ?? "https://pouriaetab.github.io/llmledger/data.json";
const raw = src.startsWith("http") ? await (await fetch(src)).json() : await Bun.file(src).json();
const cat = buildCatalog(raw);
const out = new URL("../data/catalog.json", import.meta.url).pathname;
writeFileSync(out, JSON.stringify(cat));
const byProvider: Record<string, { all: number; top: string[] }> = {};
for (const m of cat.models) {
  const p = (byProvider[m.provider] ??= { all: 0, top: [] });
  p.all++;
  if (m.top) p.top.push(m.label);
}
console.log(`catalogue built ${cat.built} · ${cat.models.length} models · ${(JSON.stringify(cat).length / 1024).toFixed(0)} KB -> ${out}`);
for (const [p, v] of Object.entries(byProvider)) console.log(`  ${p.padEnd(10)} ${String(v.all).padStart(3)} models · short list: ${v.top.join(", ")}`);
