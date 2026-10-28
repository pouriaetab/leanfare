// Where Ollama keeps its models: on this computer's disk, or on a drive through a link (a models folder moved
// to another drive), with that drive's free space; a drive that is not attached; models on a drive that Ollama
// does not use, and linking Ollama's folder to them. The drives are folders in a made up drive root.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveOf, foundElsewhere, modelsDir, probe, whereModels } from "../src/local";
import { ALL_TICKED, boot, fake, reset, ui } from "./app";
import { closeApp, openApp } from "./dom";

let url = "";
let drives = "";
// The tests' own home (test/setup.ts), never yours: Bun's homedir() would give yours.
const HOME = () => { const h = process.env.HOME!; if (!h.includes("leanfare-test-home-")) throw new Error(`not the tests' home: ${h}`); return h; };
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  await reset({ ticked: ALL_TICKED });
  await ui(url, "/api/refresh", { what: "ollama" });
  drives = realpathSync(mkdtempSync(join(tmpdir(), "leanfare-drives-")));
  Object.assign(probe, { roots: () => [drives], free: (p: string) => (p.startsWith(drives) ? 812e9 : 120e9) });
  rmSync(join(HOME(), ".ollama"), { recursive: true, force: true }); // the tests' own home (test/setup.ts)
});
afterEach(() => { closeApp(); rmSync(drives, { recursive: true, force: true }); rmSync(join(HOME(), ".ollama"), { recursive: true, force: true }); });

// A models folder as Ollama keeps it: a manifest per model and tag, the pieces in blobs.
function modelsFolder(at: string, models: string[]) {
  for (const m of models) {
    const [name, tag] = m.split(":");
    mkdirSync(join(at, "manifests", "registry.ollama.ai", "library", name), { recursive: true });
    writeFileSync(join(at, "manifests", "registry.ollama.ai", "library", name, tag), "{}");
  }
  mkdirSync(join(at, "blobs"), { recursive: true });
  models.forEach((_, i) => writeFileSync(join(at, "blobs", `sha256-${i}`), Buffer.alloc(1000 * (i + 1))));
  return at;
}
const linkOllama = (to: string) => { mkdirSync(join(HOME(), ".ollama"), { recursive: true }); symlinkSync(to, modelsDir(), "dir"); };

describe("where the models are", () => {
  test("on this computer's own disk: the folder and its free space", async () => {
    const w = whereModels();
    expect(w).toMatchObject({ dir: join(HOME(), ".ollama", "models"), drive: null, linked: false, missing: false, free: 120e9 });
    const o = (await ui(url, "/api/local")).json;
    expect(o.where.drive).toBeNull();
    expect(o.disk.free).toBe(120e9);
  });

  test("on a drive, through a link: the drive's name and its free space, which is where downloads go", async () => {
    const at = modelsFolder(join(drives, "Ezekers", "Mac-Offload", "ollama-models"), ["qwen3.5:9b", "qwen3.5:4b"]);
    linkOllama(at);
    expect(whereModels()).toMatchObject({ real: at, drive: "Ezekers", linked: true, missing: false, free: 812e9 });
    const o = (await ui(url, "/api/local")).json;
    expect(o.where.drive).toBe("Ezekers");
    expect(o.disk.free).toBe(812e9); // the check before a download counts the drive's space
    expect(o.found).toEqual([]); // the folder Ollama uses is not offered again
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#localCard")?.textContent.includes("Where your models are"); i++) await Bun.sleep(50);
    expect(doc.querySelector("#localCard").textContent).toContain("Ollama keeps your 1 model (2.0 GB) on the drive Ezekers, with 812 GB free. New downloads go there too.");
  });

  test("a drive that is not attached: said plainly, and no free space is made up", async () => {
    linkOllama(join(drives, "Gone", "ollama-models"));
    expect(whereModels()).toMatchObject({ drive: "Gone", linked: true, missing: true, free: null });
    const o = (await ui(url, "/api/local")).json;
    expect(o.where.missing).toBe(true);
    expect(o.disk.known).toBe(false);
  });

  test("the drive of a path: a folder in a drive root, a Windows drive letter that is not the system's", () => {
    expect(driveOf(join(drives, "Ezekers", "models"))).toBe("Ezekers");
    expect(driveOf("/home/me/.ollama/models")).toBeNull();
    expect(driveOf("D:\\ollama\\models")).toBe("D:");
    expect(driveOf("C:\\Users\\me\\.ollama\\models")).toBeNull();
  });
});

describe("models on a drive that Ollama does not use", () => {
  test("found up to three folders deep, with how many and how big; hidden and deeper folders are not searched", async () => {
    const at = modelsFolder(join(drives, "Ezekers", "Mac-Offload", "ollama-models"), ["qwen3.5:9b", "qwen3.5:4b"]);
    modelsFolder(join(drives, "Ezekers", ".Trashes", "ollama-models"), ["old:1b"]);
    modelsFolder(join(drives, "Ezekers", "a", "b", "c", "d", "ollama-models"), ["deep:1b"]);
    expect(foundElsewhere()).toEqual([{ path: at, drive: "Ezekers", models: 2, size: 3000 }]);
    const o = (await ui(url, "/api/local")).json;
    expect(o.found).toEqual([{ path: at, drive: "Ezekers", models: 2, size: 3000 }]);
  });

  test("with none of Ollama's own, the reading suggestion is to use them, not to download another", async () => {
    modelsFolder(join(drives, "Ezekers", "ollama-models"), ["qwen3.5:9b", "qwen3.5:4b"]);
    fake.ollama.models = [];
    await ui(url, "/api/refresh", { what: "ollama" });
    const o = (await ui(url, "/api/local")).json;
    expect(o.kinds[0]).toMatchObject({ kind: "read", pick: null });
    expect(o.kinds[0].why).toBe("Ollama has no models of its own here. Use the 2 models on Ezekers first (above): then Leanfare can test one.");
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#localCard .krow"); i++) await Bun.sleep(50);
    expect(doc.querySelector("#localCard").textContent).toContain("Ollama has no models yet. Its folder is in ");
  });

  test("Use them: Ollama's empty folder is kept under another name and becomes a link to them", async () => {
    const at = modelsFolder(join(drives, "Ezekers", "ollama-models"), ["qwen3.5:9b"]);
    mkdirSync(join(modelsDir(), "manifests"), { recursive: true }); // Ollama's own folder, with no models
    const r = await ui(url, "/api/local/use", { path: at });
    expect(r.status).toBe(200);
    expect(lstatSync(modelsDir()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(modelsDir())).toBe(at);
    expect(existsSync(join(HOME(), ".ollama", "models-before-leanfare", "manifests"))).toBe(true); // nothing deleted
    expect(r.json.text).toContain("on Ezekers, and new downloads go there too. What was in models before is kept as models-before-leanfare.");
    expect(r.json.local.where).toMatchObject({ drive: "Ezekers", linked: true });
    expect(r.json.local.found).toEqual([]);
  });

  test("not over models of Ollama's own, not for a folder it did not find, and the screen asks first", async () => {
    const at = modelsFolder(join(drives, "Ezekers", "ollama-models"), ["qwen3.5:9b"]);
    modelsFolder(modelsDir(), ["llama3.2:latest"]);
    const own = await ui(url, "/api/local/use", { path: at });
    expect(own.status).toBe(409);
    expect(own.json.error).toContain("Ollama has 1 model of its own in");
    expect(lstatSync(modelsDir()).isSymbolicLink()).toBe(false); // left as it was
    const none = await ui(url, "/api/local/use", { path: join(drives, "nothing") });
    expect(none.status).toBe(404);
    rmSync(modelsDir(), { recursive: true, force: true });
    const doc = await openApp(url);
    doc.querySelector('.tabs button[data-tab="settings"]').click();
    for (let i = 0; i < 160 && !doc.querySelector("#localCard .found"); i++) await Bun.sleep(50);
    expect(doc.querySelector("#localCard .found").textContent).toContain("1 model on Ezekers");
    [...doc.querySelectorAll("#localCard .found button")].find((b: any) => b.textContent === "Use them").click();
    expect(doc.querySelector("#localCard .lconfirm").textContent).toContain(`Ollama's models folder will point to ${at}`);
    expect(existsSync(modelsDir())).toBe(false); // nothing yet: only the yes does it
    [...doc.querySelectorAll("#localCard .lconfirm button")].find((b: any) => b.textContent === "Use them").click();
    for (let i = 0; i < 100 && !existsSync(modelsDir()); i++) await Bun.sleep(50);
    expect(readlinkSync(modelsDir())).toBe(at);
  });
});
