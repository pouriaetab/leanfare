// Local models: what Ollama has, removing a model, and downloading one with progress.
// The fake plays Ollama's side (test/fake.ts, `fake.ollama`): its model list, what is loaded, a
// download that streams JSON lines and can fail, be cut off or be held for a Stop, and a removal.
// reset() gives every test the same computer: 16 GB of memory and 200 GB of free disk.
import { tmpdir } from "node:os";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fit, gb, normalizeName, probe, realProbe } from "../src/local";
import { settings } from "../src/settings";
import { ALL_TICKED, boot, fake, outgoing, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); await ui(url, "/api/refresh", { what: "ollama" }); });

const GB = 1e9;
const overview = async () => (await ui(url, "/api/local")).json;
const pull = async () => (await ui(url, "/api/local/pull")).json.pull;
const startPull = (name: string, extra: Record<string, unknown> = {}) => ui(url, "/api/local/pull", { name, ...extra });
const pulls = () => fake.seen.filter((s) => s.path === "/ollama/api/pull");
async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) { await Bun.sleep(15); v = await read(); }
  return v;
}
const finished = () => until(pull, (p: any) => !p?.active);

describe("will it run here (fits, tight, too big)", () => {
  test("16 GB of memory: up to half is comfortable, up to 70% is tight, past that is too big", () => {
    const mem = 16 * GB;
    expect(fit(2 * GB, mem)).toBe("fits");
    expect(fit((mem * 0.5) / 1.2, mem)).toBe("fits"); // the edge itself
    expect(fit(7.3 * GB, mem)).toBe("tight");
    expect(fit(8.1 * GB, mem)).toBe("tight");
    expect(fit((mem * 0.7) / 1.2 + 1, mem)).toBe("too big");
    expect(fit(17.4 * GB, mem)).toBe("too big");
  });
  test("a small Mac gets a smaller answer for the same model", () => {
    expect(fit(4.4 * GB, 8 * GB)).toBe("tight");
    expect(fit(8.1 * GB, 8 * GB)).toBe("too big");
    expect(fit(4.4 * GB, 32 * GB)).toBe("fits");
  });
  test("sizes are written in gigabytes with one decimal below ten", () => {
    expect(gb(8.1e9)).toBe("8.1 GB");
    expect(gb(17.4e9)).toBe("17 GB");
    expect(gb(2_019_393_189)).toBe("2.0 GB");
  });
  test("the real probe reads this computer's disk and memory", () => {
    expect(realProbe.free(tmpdir())).toBeGreaterThan(0);
    expect(realProbe.free("/no/such/folder/yet")).toBeGreaterThan(0); // climbs to the nearest folder that exists
    expect(realProbe.memory()).toBeGreaterThan(1e9);
  });
});

describe("what can be typed as a model name", () => {
  test("Ollama names, Hugging Face names and a pasted Hugging Face page all work", () => {
    expect(normalizeName("gemma3:12b")).toBe("gemma3:12b");
    expect(normalizeName("  llama3.2  ")).toBe("llama3.2");
    expect(normalizeName("hf.co/acme/small-GGUF:Q4_K_M")).toBe("hf.co/acme/small-GGUF:Q4_K_M");
    expect(normalizeName("hf.co/acme/small-GGUF")).toBe("hf.co/acme/small-GGUF");
    expect(normalizeName("https://huggingface.co/acme/small-GGUF")).toBe("hf.co/acme/small-GGUF");
    expect(normalizeName("https://huggingface.co/acme/small-GGUF/tree/main")).toBe("hf.co/acme/small-GGUF");
    expect(normalizeName("ollama run gemma3:12b")).toBe("gemma3:12b");
    expect(normalizeName("library/gemma3")).toBe("library/gemma3");
  });
  test("anything else is refused before it reaches Ollama", () => {
    for (const bad of ["", "   ", "a b", "../etc/passwd", "gemma3;rm -rf", "hf.co/onlyuser", "hf.co/", "http://evil.example/model", "a//b", "-flag", "x".repeat(201), null, 42])
      expect(normalizeName(bad as any)).toBeNull();
  });
});

describe("what Ollama has", () => {
  test("the installed models with size, kind, what is loaded and whether each fits", async () => {
    fake.ollama.models.push({ name: "gemma3:12b", model: "gemma3:12b", modified_at: "2026-10-10T00:00:00Z", size: 8.1 * GB, details: { family: "gemma3", parameter_size: "12.2B", quantization_level: "Q4_K_M" } });
    fake.ollama.loaded.push("gemma3:12b");
    const o = await overview();
    expect(o.running).toBe(true);
    expect(o.installed.map((m: any) => m.name)).toEqual(["gemma3:12b", "llama3.2:latest"]);
    const g = o.installed[0];
    expect(g).toMatchObject({ size: 8.1 * GB, params: "12.2B", quant: "Q4_K_M", family: "gemma3", loaded: true, fit: "tight" });
    expect(o.installed[1]).toMatchObject({ loaded: false, fit: "fits" });
    expect(o.total).toBeCloseTo(8.1 * GB + 2_019_393_189, -3);
    expect(o.memory).toEqual({ total: 16 * GB, usable: 11.2 * GB });
    expect(o.disk).toMatchObject({ free: 200 * GB, minFree: 10 * GB, known: true });
    expect(o.remote).toBe(false);
  });
  test("when Ollama is not running, the answer is the one line: where to get it", async () => {
    fake.ollama.down = true;
    const o = await overview();
    expect(o).toMatchObject({ running: false, installed: [], total: 0, installUrl: "https://ollama.com/download" });
    expect(o.tried).toContain("/api/tags");
  });
  test("an Ollama on another computer is not measured against this computer's disk", async () => {
    const old = process.env.LEANFARE_OLLAMA_BASE;
    const before = outgoing.length;
    process.env.LEANFARE_OLLAMA_BASE = "http://10.255.255.1:11434/v1";
    try {
      const o = await overview();
      expect(o.remote).toBe(true);
      expect(o.disk).toMatchObject({ free: null, known: false });
    } finally {
      process.env.LEANFARE_OLLAMA_BASE = old;
      // This test reaches another computer on purpose, as someone who set one up would. That address
      // leaves the record of what Leanfare reached, so the no telemetry checks hold in any test order.
      for (let i = outgoing.length - 1; i >= before; i--) if (outgoing[i].includes("//10.255.255.1:")) outgoing.splice(i, 1);
    }
  }, 15000);
  test("the screens' state carries the download, so a page that opens later can pick it up", async () => {
    expect((await ui(url, "/api/state")).json.local).toEqual({ pull: null });
    fake.ollama.holding = true;
    await startPull("gemma3:12b");
    await until(pull, (p: any) => p?.percent > 0);
    expect((await ui(url, "/api/state")).json.local.pull).toMatchObject({ name: "gemma3:12b", active: true });
    await ui(url, "/api/local/pull/stop", {});
  });
});

describe("removing a model", () => {
  test("it is removed from Ollama, unticked, no longer the usual model, and the size freed is reported", async () => {
    await ui(url, "/api/models/tick", { ids: ["ollama/llama3.2:latest"], on: true });
    await ui(url, "/api/settings", { usual: "ollama/llama3.2:latest" });
    const r = await ui(url, "/api/local/delete", { name: "llama3.2:latest" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, name: "llama3.2:latest", freed: 2_019_393_189 });
    expect(fake.ollama.models).toHaveLength(0);
    expect(settings().ticked).not.toContain("ollama/llama3.2:latest");
    expect(settings().usual).toBeNull();
    expect(r.json.state.models.ollama ?? []).toHaveLength(0);
    expect(fake.seen.find((s) => s.method === "DELETE")?.body).toMatchObject({ model: "llama3.2:latest" });
  });
  test("a model Ollama does not have is not asked about", async () => {
    const r = await ui(url, "/api/local/delete", { name: "nothing:1b" });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("Ollama does not have that model (any more).");
    expect(fake.seen.filter((s) => s.method === "DELETE")).toHaveLength(0);
    expect((await ui(url, "/api/local/delete", {})).status).toBe(404); // no name at all
  });
  test("when Ollama refuses, the model stays ticked and listed, and the reason is shown", async () => {
    fake.ollama.deleteStatus = 500;
    const r = await ui(url, "/api/local/delete", { name: "llama3.2:latest" });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("Ollama would not remove it: fake delete failure");
    expect(fake.ollama.models).toHaveLength(1);
    expect(settings().ticked).toContain("ollama/llama3.2:latest");
  });
  test("when Ollama is not running, nothing is removed and it says so", async () => {
    fake.ollama.down = true;
    const r = await ui(url, "/api/local/delete", { name: "llama3.2:latest" });
    expect(r.status).toBe(503);
    expect(r.json.error).toContain("Ollama is not running on this computer, so nothing was removed");
  });
});

describe("downloading a model", () => {
  test("it downloads with progress that only goes forward, and the model is listed, ticked and ready", async () => {
    fake.ollama.gap = 40;
    const s = await startPull("gemma3:12b");
    expect(s.status).toBe(200);
    expect(s.json.pull).toMatchObject({ name: "gemma3:12b", active: true });
    const seen: number[] = [];
    let last: any = null;
    for (let i = 0; i < 400; i++) {
      last = await pull();
      if (last.percent !== null) seen.push(last.percent);
      if (!last.active) break;
      await Bun.sleep(15);
    }
    expect(last).toMatchObject({ status: "done", active: false, percent: 100, model: "ollama/gemma3:12b", fit: "tight" });
    expect(last.message).toBe("Downloaded gemma3:12b (8.1 GB). It is ticked. Leanfare has no rating for this name, so Auto does not pick it: choose it by name in the chat.");
    expect(seen.some((p) => p > 0 && p < 100)).toBe(true); // it was seen part way
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(pulls()).toHaveLength(1);
    expect(pulls()[0].body).toMatchObject({ model: "gemma3:12b", stream: true });
    expect(fake.ollama.models.map((m) => m.name)).toContain("gemma3:12b");
    expect(settings().ticked).toContain("ollama/gemma3:12b");
    const state = (await ui(url, "/api/state")).json;
    expect(state.models.ollama.map((m: any) => m.id)).toContain("ollama/gemma3:12b");
  });
  test("a pasted Hugging Face page address downloads the model Ollama reads from there", async () => {
    await startPull("https://huggingface.co/acme/small-GGUF");
    // no :quantization, so the fake does not know it; Ollama's own answer is passed on in plain words
    const p = await finished();
    expect(pulls()[0].body.model).toBe("hf.co/acme/small-GGUF");
    expect(p.status).toBe("failed");
    expect(p.message).toBe("Ollama has no model called hf.co/acme/small-GGUF. Check the name (for Hugging Face: hf.co/user/repo:quantization).");
    await startPull("hf.co/acme/small-GGUF:Q4_K_M");
    expect((await finished()).status).toBe("done");
    expect(fake.ollama.models.map((m) => m.name)).toContain("hf.co/acme/small-GGUF:Q4_K_M");
  });
  test("a name without a tag is listed under the tag Ollama gives it", async () => {
    fake.ollama.library["tinyllama"] = 0.6 * GB;
    await startPull("tinyllama");
    const p = await finished();
    expect(p).toMatchObject({ status: "done", model: "ollama/tinyllama:latest" });
  });
  test("only one download at a time; the second is refused with the first one's name", async () => {
    fake.ollama.holding = true;
    await startPull("gemma3:12b");
    await until(pull, (p: any) => p?.percent > 0);
    const second = await startPull("tiny:1b");
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("gemma3:12b is still downloading. Stop it first, or wait until it is done.");
    expect(pulls()).toHaveLength(1);
    await ui(url, "/api/local/pull/stop", {});
  });
  test("a bad name is refused without asking Ollama", async () => {
    const r = await startPull("hf.co/onlyuser");
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("That is not a model name");
    expect(pulls()).toHaveLength(0);
    expect((await startPull(undefined as any)).status).toBe(400);
  });
  test("Ollama not running: it says so and offers the download page, and starts nothing", async () => {
    fake.ollama.down = true;
    const r = await startPull("gemma3:12b");
    expect(r.status).toBe(503);
    expect(r.json.error).toContain("Ollama is not running on this computer");
    expect(r.json.error).toContain("https://ollama.com/download");
    expect(await pull()).toBeNull();
  });
});

describe("Stop, and carrying on where it stopped", () => {
  test("Stop ends the download, tells Ollama, keeps what is there, and Download continues from it", async () => {
    fake.ollama.holding = true;
    await startPull("gemma3:12b");
    const part = await until(pull, (p: any) => p?.percent >= 30);
    expect(part.percent).toBeGreaterThanOrEqual(30);
    await ui(url, "/api/local/pull/stop", {});
    const p = await pull();
    expect(p).toMatchObject({ status: "stopped", active: false, message: "Stopped. What was downloaded is kept; press Download to continue." });
    await until(() => pulls()[0].aborted, (a) => a === true);
    expect(pulls()[0].aborted).toBe(true);
    const kept = fake.ollama.partial["gemma3:12b"];
    expect(kept).toBeGreaterThan(0);
    expect(settings().ticked).not.toContain("ollama/gemma3:12b");
    fake.ollama.holding = false;
    await startPull("gemma3:12b");
    const again = await until(pull, (x: any) => x?.completed > 0);
    expect(again.completed).toBeGreaterThanOrEqual(kept); // it did not start over
    expect((await finished()).status).toBe("done");
    expect(pulls()).toHaveLength(2);
  });
  test("Stop with nothing running does nothing", async () => {
    const r = await ui(url, "/api/local/pull/stop", {});
    expect(r.status).toBe(200);
    expect(r.json.pull).toBeNull();
  });
  test("a finished or failed download stays on screen until it is dismissed", async () => {
    fake.ollama.error = "pull model manifest: file does not exist";
    await startPull("gemma3:12b");
    await finished();
    expect((await pull()).status).toBe("failed");
    await ui(url, "/api/local/pull/dismiss", {});
    expect(await pull()).toBeNull();
    await ui(url, "/api/local/pull/dismiss", {}); // nothing there: fine
  });
  test("dismissing does not touch a download that is running", async () => {
    fake.ollama.holding = true;
    await startPull("gemma3:12b");
    await until(pull, (p: any) => p?.percent > 0);
    await ui(url, "/api/local/pull/dismiss", {});
    expect((await pull()).active).toBe(true);
    await ui(url, "/api/local/pull/stop", {});
  });
});

describe("when a download fails, it says why in plain words", () => {
  const failWith = async (patch: Partial<typeof fake.ollama>, name = "gemma3:12b") => {
    Object.assign(fake.ollama, patch);
    await startPull(name);
    return finished();
  };
  test("a name that does not exist (Ollama answers inside the stream)", async () => {
    const p = await failWith({}, "nosuchmodel:7b");
    expect(p).toMatchObject({ status: "failed", message: "Ollama has no model called nosuchmodel:7b. Check the name (for Hugging Face: hf.co/user/repo:quantization)." });
  });
  test("a name that does not exist (Ollama answers with an error status)", async () => {
    const p = await failWith({ http: 404, httpMessage: "pull model manifest: file does not exist" });
    expect(p.message).toStartWith("Ollama has no model called gemma3:12b.");
  });
  test("a model that needs a Hugging Face sign in", async () => {
    const p = await failWith({ error: "pull model manifest: 401: unauthorized" });
    expect(p.message).toBe("gemma3:12b needs a sign in on Hugging Face (it is a gated model), which Leanfare cannot do. Choose another model.");
  });
  test("a full disk, reported by Ollama itself", async () => {
    const p = await failWith({ error: "write ~/.ollama/models/blobs/sha256-1: no space left on device" });
    expect(p.message).toBe("The disk is full. Free some space, then press Download to continue.");
  });
  test("no internet", async () => {
    const p = await failWith({ error: "pull model manifest: Get \"https://registry.ollama.ai/v2/library/gemma3/manifests/12b\": dial tcp: lookup registry.ollama.ai: no such host" });
    expect(p.message).toBe("The download was cut off (Ollama could not reach the download server). Check your internet connection, then press Download to continue where it stopped.");
  });
  test("any other Ollama error is quoted, shortened", async () => {
    const p = await failWith({ error: "something odd ".repeat(40) });
    expect(p.message).toStartWith("Ollama said: something odd");
    expect(p.message.length).toBeLessThan(230);
  });
  test("a connection that closes with no success line is not called done", async () => {
    const p = await failWith({ cut: true });
    expect(p).toMatchObject({ status: "failed", message: "The download stopped before it was finished (Ollama closed the connection). Press Download to continue where it stopped." });
    expect(settings().ticked).not.toContain("ollama/gemma3:12b");
  });
  test("updating a model that is already installed: a cut off download is not called done", async () => {
    fake.ollama.library["llama3.2:latest"] = 2_019_393_189; // installed already (the fake starts with it)
    const p = await failWith({ cut: true }, "llama3.2:latest");
    expect(p).toMatchObject({ status: "failed", message: "The download stopped before it was finished (Ollama closed the connection). Press Download to continue where it stopped." });
  });
  test("updating a model that is already installed, to the end, is done and stays ticked", async () => {
    fake.ollama.library["llama3.2:latest"] = 2_019_393_189;
    await startPull("llama3.2:latest");
    expect(await finished()).toMatchObject({ status: "done", model: "ollama/llama3.2:latest" });
  });
  test("a failed download can be started again", async () => {
    await failWith({ error: "boom" });
    Object.assign(fake.ollama, { error: null });
    await startPull("gemma3:12b");
    expect((await finished()).status).toBe("done");
  });
});

describe("disk and memory are checked first (the 10 GB rule)", () => {
  test("a size known up front that leaves less than 10 GB free is refused, and Ollama is not asked", async () => {
    probe.free = () => 15 * GB;
    const r = await startPull("gemma3:12b", { sizeBytes: 8.1 * GB });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("This needs about 8.1 GB more, and the disk has 15 GB free. Leanfare keeps 10 GB free for the computer itself, so free up at least 3.1 GB first.");
    expect(pulls()).toHaveLength(0);
    expect(await pull()).toBeNull();
  });
  test("exactly 10 GB left afterwards is allowed", async () => {
    probe.free = () => 18.1 * GB;
    expect((await startPull("gemma3:12b", { sizeBytes: 8.1 * GB })).status).toBe(200);
    expect((await finished()).status).toBe("done");
  });
  test("a size known up front that is too big for the memory is refused", async () => {
    const r = await startPull("gemma3:27b", { sizeBytes: 17.4 * GB });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("gemma3:27b is about 17 GB, which is too big for this computer's memory (16 GB). Choose a smaller model or a lighter version (a smaller number of billions, or a name ending in :Q4_K_M).");
    expect(pulls()).toHaveLength(0);
  });
  test("a size nobody knew is checked the moment Ollama reports it, and the download is stopped", async () => {
    probe.free = () => 15 * GB;
    await startPull("gemma3:12b"); // no size given
    const p = await finished();
    expect(p).toMatchObject({ status: "failed", size: 8.1 * GB });
    expect(p.message).toContain("This needs about 7.1 GB more"); // only what is still missing counts: the first line already had an eighth
    expect(p.message).toContain("free up at least 2.1 GB first");
    await until(() => pulls()[0].aborted, (a) => a === true);
    expect(pulls()[0].aborted).toBe(true);
    expect(settings().ticked).not.toContain("ollama/gemma3:12b");
  });
  test("a size nobody knew that is too big for the memory is stopped the same way", async () => {
    await startPull("gemma3:27b");
    const p = await finished();
    expect(p.status).toBe("failed");
    expect(p.message).toStartWith("gemma3:27b is about 17 GB, which is too big for this computer's memory (16 GB).");
  });
  test("a tight fit is allowed and labelled", async () => {
    await startPull("gemma3:12b");
    expect((await until(pull, (p: any) => p?.fit)).fit).toBe("tight");
    await finished();
  });
  test("a model that fits is labelled so", async () => {
    await startPull("tiny:1b");
    const p = await finished();
    expect(p).toMatchObject({ status: "done", fit: "fits" });
  });
  test("when the disk cannot be measured, the download goes ahead", async () => {
    probe.free = () => null;
    await startPull("gemma3:12b");
    expect((await finished()).status).toBe("done");
  });
  test("a size hint that is not a positive number is ignored", async () => {
    await startPull("tiny:1b", { sizeBytes: "big" });
    expect((await finished()).status).toBe("done");
    await ui(url, "/api/local/pull/dismiss", {});
    await startPull("tiny:1b", { sizeBytes: -5 });
    expect((await finished()).status).toBe("done");
  });
});

describe("the access key covers the new addresses", () => {
  test("with the lock on, the page's local-model addresses need the cookie like every other", async () => {
    const lock = await ui(url, "/api/lock", { on: true });
    expect(lock.status).toBe(200);
    for (const [path, body] of [["/api/local", undefined], ["/api/local/pull", undefined], ["/api/local/pull", { name: "tiny:1b" }], ["/api/local/delete", { name: "llama3.2:latest" }]] as const) {
      const r = await ui(url, path, body as any);
      expect(r.status).toBe(401);
    }
    expect(pulls()).toHaveLength(0);
    expect(fake.seen.filter((s) => s.method === "DELETE")).toHaveLength(0);
    await ui(url, "/api/lock", { on: false }); // (the page's own cookie is not needed to turn it off in this test: reset() clears settings)
  });
});
