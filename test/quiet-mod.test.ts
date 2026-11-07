// 0.15.3: the leanfare-level mod asks the person nothing. In a Cowork task in the cloud, Leanfare is reached through the
// desktop app's link to the computer, and Cowork asks before every call there, with no "always allow": the mod's own
// calls (the level every 10 minutes, and again a minute after a refusal, a model for each helper, each turn's numbers)
// made over 10 questions in one task (5 Nov 2026). Now it reads the level from the first line of the level tool's
// description, which Leanfare writes, and calls Leanfare only on Leanfare's own server. Here the mod runs against a
// stand-in for the app's engine.
import { describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowLine, OFF_LEVEL } from "../src/mcp";
import { OFF_TEXT } from "../src/switch";

// The engine's own module and its drawing function, as a stand-in: values the session holds, and a tree as plain data.
mock.module("claude-code", () => ({
  atom: (ref: any, initial: any) => ({ ref, initial }),
  read: async ($: any, a: any) => ($.state.has(a.ref.key) ? $.state.get(a.ref.key) : a.initial),
  update: async ($: any, a: any, fn: (v: any) => any) => { const v = fn($.state.has(a.ref.key) ? $.state.get(a.ref.key) : a.initial); $.state.set(a.ref.key, v); return v; },
}));
(globalThis as any).h = (type: unknown, props: any, ...children: unknown[]) => ({ type, props: props ?? {}, children });
const SRC = join(import.meta.dir, "..", "mods", "leanfare-level", "hooks", "register.ts");
const DIR = mkdtempSync(join(tmpdir(), "lf-mod-"));
let copies = 0;
// A fresh copy of the module for each test: its own variables start over, as in a new session.
async function load(): Promise<any> {
  const f = join(DIR, `register-${++copies}.ts`);
  copyFileSync(SRC, f);
  return await import(f);
}
type Tool = { name: string; description?: string };
// The engine: the tools this session lists, and Leanfare's servers (a server with no answers is not there).
function engine(tools: Tool[], answers: Record<string, any> = {}, kept: Record<string, unknown> = {}) {
  const calls: [string, string, any][] = [];
  const told: string[] = [];
  const $ = {
    state: new Map<string, unknown>(),
    store: { get: async (k: string) => kept[k], set: async (k: string, v: unknown) => { kept[k] = v; } },
    session: { append: async (x: any) => { told.push(x.message.content[0].text); } },
    ui: { resolve: () => ({ Box: "Box", Text: "Text", Select: "Select" }) },
    tool: { list: async () => tools.map((t) => ({ mcp: true, description: "", ...t })) },
    mcp: { call: async (server: string, tool: string, args: any) => {
      calls.push([server, tool, args]);
      const a = answers[`${server}/${tool}`];
      if (a === undefined) throw new Error(`no server named ${server}`);
      return a;
    } },
  };
  return { $, calls, told, kept };
}
function hooks(mod: any) {
  const h: Record<string, (...a: any[]) => any> = {};
  // on(event, hook) or on(event, matcher, hook), as the engine takes it.
  mod.register((event: string, a: any, b?: any) => { h[event] = typeof a === "function" ? a : b; return { catch: () => undefined }; }, {});
  return h;
}
const core = async () => ({ sections: [{ id: "core", text: "core", scope: "shared" }] });
const view = (level: 1 | 2 | 3 | 4 | 5) => ({ level, base: level, from: "default" as const, raised: null });
const LINK = "mcp__remote-devices__leanfare__";
const STATIC = "How much to hand to Leanfare first, from 1 to 5.";
const ran: string[] = [];
const go = async (x: any) => { ran.push(x.tool); return { result: "ok" }; };
const section = (r: any) => r.sections.find((s: any) => s.id === "leanfare:level");

describe("the leanfare-level mod asks nothing", () => {
  test("through the link: the level from the description, the section and the plan-first turn back, and not one call", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: `${nowLine(view(4), true)}\n\n${STATIC}` }, { name: `${LINK}plan` }]);
    const s = section(await h["prompt.compose"](e.$, {}, core));
    expect(s.text).toStartWith("Leanfare: level 4 (Most) in this chat.");
    expect(s.text).toContain("no need to call Leanfare's level tool again");
    await h["prompt.submit"](e.$, { text: "fix the bug" }, async (x: any) => x);
    expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ deny: mod.firstWords(4) });
    expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ result: "ok" }); // the next one goes through
    let spawned: any = null;
    await h["agent.spawn"](e.$, { prompt: "Part 3: read the logs", description: "Read", subagentType: "Explore", model: "fable" }, async (x: any) => { spawned = x; return { agentId: "a1" }; });
    expect(spawned.model).toBe("fable"); // the model the plan named, as Claude gave it
    await h["turn.complete"](e.$, { reason: "answer", agentId: "a1", usage: { model: "claude-fable-5-1", input_tokens: 10, output_tokens: 5 } }, async () => ({ text: "" }));
    await h["turn.complete"](e.$, { reason: "answer", usage: { model: "claude-opus-5-5", input_tokens: 20408, cache_read_input_tokens: 12888044, output_tokens: 9842 } }, async () => ({ text: "" }));
    expect(e.calls).toEqual([]); // no level read, no helper's model, no turn's numbers: no question
  });

  test("switched off, as the description says: no section, nothing turned back, no call", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: `${nowLine(view(4), false)}\n\n${STATIC}` }]);
    expect(section(await h["prompt.compose"](e.$, {}, core))).toBeUndefined();
    await h["prompt.submit"](e.$, { text: "hi" }, async (x: any) => x);
    expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ result: "ok" });
    expect(e.calls).toEqual([]);
  });

  test("an older Leanfare through the link, with no line: nothing asked, not even once, though the link would answer", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: STATIC }], { "remote-devices/leanfare__level": { isError: false, content: [], structuredContent: { level: 4, advice: "x" } } });
    for (let i = 0; i < 3; i++) {
      expect(section(await h["prompt.compose"](e.$, {}, core))).toBeUndefined();
      await h["prompt.submit"](e.$, { text: "go" }, async (x: any) => x);
      expect(await h["tool.call"](e.$, { tool: "Read", file_path: "a" }, go)).toEqual({ result: "ok" });
    }
    expect(e.calls).toEqual([]);
  });

  test("on Leanfare's own server: the level read there, a model for each helper and the counts, never through the link", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: "mcp__leanfare__level", description: STATIC }, { name: "mcp__leanfare__helper" }], {
      "leanfare/level": { isError: false, content: [], structuredContent: { level: 3, advice: "Leanfare: level 3.", note: "One grade call." } },
      "leanfare/helper": { isError: false, content: [], structuredContent: { id: 7, model: "opus" } },
    });
    expect(section(await h["prompt.compose"](e.$, {}, core)).text).toStartWith("Leanfare: level 3. One grade call.");
    let spawned: any = null;
    await h["agent.spawn"](e.$, { prompt: "Part 2", description: "Draft", subagentType: "general-purpose" }, async (x: any) => { spawned = x; return { agentId: "a1" }; });
    expect(spawned.model).toBe("opus");
    await h["turn.complete"](e.$, { reason: "answer", agentId: "a1", usage: { model: "claude-opus-5-5", input_tokens: 10, output_tokens: 5 } }, async () => ({ text: "" }));
    await h["turn.complete"](e.$, { reason: "answer", usage: { model: "claude-sonnet-5-5", input_tokens: 10, output_tokens: 5 } }, async () => ({ text: "" }));
    expect(e.calls.map(([s, t, a]) => `${s}/${t}${a.done ? ":done" : a.turn ? ":turn" : a.task ? ":pick" : ""}`)).toEqual(["leanfare/level", "leanfare/helper:pick", "leanfare/helper:done", "leanfare/helper:turn"]);
  });

  test("Leanfare's answer that it is switched off stops the plan-first turn back at once, until the list says something new", async () => {
    const real = Date.now;
    let t = real();
    Date.now = () => t;
    try {
      const mod = await load(), h = hooks(mod);
      const tools: Tool[] = [{ name: `${LINK}level`, description: nowLine(view(4), true) }];
      const e = engine(tools);
      await h["prompt.compose"](e.$, {}, core);
      await h["prompt.submit"](e.$, { text: "a" }, async (x: any) => x);
      await h["tool.call"](e.$, { tool: `${LINK}plan`, task: "a" }, async () => ({ result: { content: [{ type: "text", text: OFF_TEXT }] } }));
      await h["prompt.submit"](e.$, { text: "b" }, async (x: any) => x);
      expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ result: "ok" });
      t += 61_000; // the list read again: the same line, so Leanfare's own answer holds
      await h["prompt.submit"](e.$, { text: "c" }, async (x: any) => x);
      expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ result: "ok" });
      tools[0].description = nowLine(view(5), true); // the level changed in Leanfare, and the list with it
      t += 61_000;
      await h["prompt.submit"](e.$, { text: "d" }, async (x: any) => x);
      expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ deny: mod.firstWords(5) });
      expect(e.calls).toEqual([]);
    } finally { Date.now = real; }
  });

  test("the level tool as the engine first describes it counts when the list does not show it", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([]);
    await h["tool.describe"](e.$, { tool: `${LINK}level`, description: nowLine(view(2), true) }, async (x: any) => ({ description: x.description }));
    expect(section(await h["prompt.compose"](e.$, {}, core)).text).toStartWith("Leanfare: level 2 (Light) in this chat.");
    expect(e.calls).toEqual([]);
  });

  test("the line Leanfare writes is the line the mod reads, and its first sentence alone is enough", async () => {
    const mod = await load();
    expect(mod.fromLine(nowLine(view(3), true))).toMatchObject({ n: 3 });
    expect(mod.fromLine(nowLine(view(3), true)).advice).toStartWith("Leanfare: level 3 (More) in this chat.");
    expect(mod.fromLine(nowLine(view(5), false))).toMatchObject({ n: 1, advice: OFF_LEVEL });
    expect(mod.fromLine("Leanfare now: level 4, on.")).toMatchObject({ n: 4 });
    expect(mod.fromLine("Leanfare now: level 4, on.").advice).toContain("plan tool your first tool call");
    expect(mod.fromLine(STATIC)).toBeNull();
  });

  // 0.15.4: the Leanfare row above the message box.
  const ABOVE = { surface: "desktop", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false } };
  const drawn = (tree: any) => tree.children.filter((c: any) => c.type === "Select").map((c: any) => c.props);
  test("the row: four pickers where Leanfare's tools are, the knob's level named; nothing without them", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: nowLine(view(4), true) }]);
    const tree: any = await h["ui.render"](e.$, ABOVE, async () => "engine");
    expect(tree.type).toBe("Box");
    expect(tree.children[0]).toMatchObject({ type: "Text", children: ["Leanfare"] });
    const picks = drawn(tree);
    expect(picks.map((p: any) => [p.key, p.label, p.value])).toEqual([["leanfare-level", "Level", "knob"], ["leanfare-speed", "Speed", "app"], ["leanfare-quality", "Quality", "standard"], ["leanfare-only", "Models", "any"]]);
    expect(picks[0].options[0]).toEqual({ value: "knob", label: "Leanfare's knob (4)" });
    expect(picks[0].options.map((o: any) => o.value)).toEqual(["knob", "off", "2", "3", "4", "5"]);
    expect(e.calls).toEqual([]);
    const none = engine([]);
    expect(await hooks(await load())["ui.render"](none.$, ABOVE, async () => "engine")).toBe("engine");
    expect(await h["ui.render"](e.$, { ...ABOVE, props: { hasSurvey: true } }, async () => "survey")).toBe("survey"); // a survey goes first
  });

  test("Off in the row: every Leanfare call turned back here, so nothing is asked; the model is told, and the pick kept", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: nowLine(view(4), true) }, { name: `${LINK}plan` }]);
    const picks = drawn(await h["ui.render"](e.$, ABOVE, async () => "engine"));
    await picks[0].onSelect("off");
    expect(e.told.at(-1)).toStartWith(mod.OFF_HERE);
    expect(e.kept.row).toEqual({ level: "off", speed: "app", quality: "standard", only: "any" });
    let reached = 0;
    for (const tool of ["plan", "delegate", "plan_status", "level"]) expect(await h["tool.call"](e.$, { tool: `${LINK}${tool}` }, async () => { reached++; return { result: "ok" }; })).toEqual({ deny: mod.OFF_HERE });
    expect(reached).toBe(0);
    await h["prompt.submit"](e.$, { text: "go" }, async (x: any) => x);
    expect(await h["tool.call"](e.$, { tool: "Bash", command: "ls" }, go)).toEqual({ result: "ok" }); // no plan-first turn back
    expect(section(await h["prompt.compose"](e.$, {}, core))).toBeUndefined();
    expect(e.calls).toEqual([]);
  });

  test("level 3, fast, high and Claude only: Claude's own calls carry them, and delegate and ask are turned back", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: nowLine(view(4), true) }, { name: `${LINK}plan` }]);
    const picks = drawn(await h["ui.render"](e.$, ABOVE, async () => "engine"));
    for (const [i, v] of [[0, "3"], [1, "fastest"], [2, "high"], [3, "claude"]] as const) await picks[i].onSelect(v);
    expect(e.told.at(-1)).toStartWith("The Leanfare row above the message box now says: level 3 (More).");
    expect(e.told.at(-1)).toContain("speed fast, quality high (each part one effort step up), Claude only");
    let sent: any = null;
    await h["tool.call"](e.$, { tool: `${LINK}plan`, task: "a" }, async (x: any) => { sent = x; return { result: "ok" }; });
    expect(sent).toMatchObject({ task: "a", level: 3, speed: "fastest", split: "rules", quality: "high", only: "claude" });
    expect(await h["tool.call"](e.$, { tool: `${LINK}delegate`, task: "b" }, go)).toEqual({ deny: mod.CLAUDE_ONLY });
    expect(await h["tool.call"](e.$, { tool: `${LINK}ask`, prompt: "c" }, go)).toEqual({ deny: mod.CLAUDE_ONLY });
    expect(section(await h["prompt.compose"](e.$, {}, core)).text).toContain("level 3 (More) in this chat, as the Leanfare row says.");
    // A delegate, with Claude and Leanfare's models again: the speed and the effort.
    await picks[3].onSelect("any");
    await h["tool.call"](e.$, { tool: `${LINK}delegate`, task: "d", effort: "low" }, async (x: any) => { sent = x; return { result: "ok" }; });
    expect(sent).toMatchObject({ level: 3, speed: "fastest", effort: "high" });
    expect(e.calls).toEqual([]);
  });

  test("the row as the last chat left it, where the app keeps the mod's store", async () => {
    const mod = await load(), h = hooks(mod);
    const e = engine([{ name: `${LINK}level`, description: nowLine(view(4), true) }], {}, { row: { level: "2", speed: "balanced", quality: "standard", only: "any" } });
    await h["session.start"](e.$, { cwd: "/" }, async (x: any) => ({ cwd: x.cwd }));
    expect(await mod.inEffect(e.$)).toMatchObject({ n: 2, off: false });
    expect(mod.isRow({ level: "9" })).toBe(false);
  });
});