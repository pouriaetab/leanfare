// Claude Code's helper hook (0.15): before its Agent tool starts a helper (a subagent), Leanfare names the Claude model
// it runs on (helpers.ts), and the hook hands that model back in the call, so the plan's choice is an order. It reads
// only the call's description, prompt, agent type and model, and changes only the model. Leanfare not running, or
// anything going wrong: it prints nothing, and the helper runs as Claude Code chose.
import { call, healthy, where } from "./client";

export const HELPER_MATCHER = "^(Agent|Task)$";
// The names Claude Code's Agent tool takes for a model (it checks a hook's call against the tool): the mod takes these or
// a model's full id.
export const ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);
// What Claude Code reads back: the same call, with Leanfare's model (updatedInput replaces the whole input).
export const helperOutput = (input: Record<string, unknown>, model: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, model } } });

export async function runHelperHook() {
  try {
    const got = JSON.parse(await Bun.stdin.text());
    const input = got?.tool_input && typeof got.tool_input === "object" ? got.tool_input : null;
    if (!input || !(await healthy(where().base))) return;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const { j } = await call("/api/helper", { method: "POST", json: { app: "Claude Code", session: str(got.session_id), task: str(input.prompt), description: str(input.description), agent: str(input.subagent_type), asked: str(input.model) } });
    // Claude Code checks the call against its Agent tool, which takes these names only.
    if (typeof j?.model === "string" && ALIASES.has(j.model) && j.model !== input.model) process.stdout.write(JSON.stringify(helperOutput(input, j.model)) + "\n");
  } catch {}
}
