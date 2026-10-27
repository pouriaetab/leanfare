// One gate before any release or merge: versions, types,
// page script syntax, tests, licences, and the live smoke test.
//   bun scripts/preflight.ts            everything
//   bun scripts/preflight.ts --offline  skip the online licence checks
import { BUN_TESTED } from "../src/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const offline = process.argv.includes("--offline");
const run = async (name: string, cmd: string[]) => {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const s = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`${code === 0 ? "ok  " : "FAIL"}  ${name} (${s} s)`);
  if (code !== 0) console.log((out + err).split("\n").slice(-25).join("\n"));
  return code === 0;
};
const [maj, min] = Bun.version.split(".");
const versionOk = `${maj}.${min}` === BUN_TESTED;
console.log(`${versionOk ? "ok  " : "FAIL"}  Bun ${Bun.version} (this release is tested on ${BUN_TESTED}.x)`);
const results = [
  versionOk,
  await run("types (tsc)", [process.execPath, "x", "tsc", "-p", "."]),
  await run("page script syntax", [process.execPath, "-e", "new Function(await Bun.file('ui/app.js').text())"]),
  await run("tests", [process.execPath, "test"]),
  await run(`licences${offline ? " (offline)" : ""}`, [process.execPath, "scripts/licences.ts", ...(offline ? ["--offline"] : [])]),
  await run("smoke test", [process.execPath, "scripts/smoke.ts"]),
];
const bad = results.filter((r) => !r).length;
console.log(bad ? `\nPreflight: ${bad} check(s) failed.` : "\nPreflight: all checks passed.");
process.exit(bad ? 1 : 0);
