// Leanfare's level in Cowork and Claude Desktop (0.14.1). These apps show Leanfare's tools to the model by name only and
// never its own instructions, and they have no prompt hook for an outside program, so a chat learned the level only if
// it happened to call Leanfare's level tool. This mod runs inside the app:
//   1. the level, as Leanfare's level tool says it, goes into the system prompt of every request (read again every
//      10 minutes), so the knob in Leanfare holds in every chat;
//   2. at levels 4 and 5 the first tool call of a prompt that is not Leanfare's plan is turned back once, with the
//      reason, and the next one goes through (Claude Code's plan first hook does the same);
//   3. (0.15) every helper (subagent) Claude starts runs on the Claude model Leanfare picks for it: the plan part it is
//      for, else its kind of work, from the newest Claude models llmledger lists, by your rules in Leanfare. So the
//      plan's choice is an order. At a helper's end, and at each of the main model's turns, the model and its token
//      counts go to Leanfare for its report: numbers only, never words.
// It reads the level, and sends Leanfare only a helper's description, prompt and agent type (to pick its model) and
// token counts. Without Leanfare connected it does nothing.
import type { Register } from 'claude-code'

// Where Leanfare's tools are: its own server (the app runs it), or through the desktop app's link to the computer.
const SERVERS: [server: string, tool: string][] = [['leanfare', 'level'], ['remote-devices', 'leanfare__level']]
const REREAD = 10 * 60_000
// Tools that only look things up or keep the task list: never turned back.
const QUIET = /^(ToolSearch|Skill|TaskCreate|TaskUpdate|TaskList|TaskGet|TodoWrite|AskUserQuestion|SendUserMessage|ExitPlanMode|EnterPlanMode)$/

type Level = { n: number; advice: string; at: number }
let level: Level | null = null
let tried = 0
let prompt = 0, planned = -1, gated = -1

export const firstWords = (n: number) =>
  `Leanfare: level ${n} in this chat, so plan first: call Leanfare's plan tool (its name ends in leanfare__plan)${n === 4 ? ' with your own split in parts' : ', and Leanfare makes the split'}, then follow its table; it starts Leanfare's parts by itself. If this prompt is a quick question, go on: this call goes through when you make it again.`
export const levelSection = (l: Level) =>
  `${l.advice} Leanfare's tools have names ending in leanfare__plan, leanfare__delegate and so on: if they are deferred, load them in one ToolSearch call (+leanfare). End your reply with one line on what Leanfare did this turn.`

async function readLevel($: any): Promise<Level | null> {
  const now = Date.now()
  if (level && now - level.at < REREAD) return level
  if (!level && now - tried < 60_000) return null // not connected a minute ago: ask again later
  tried = now
  for (const [server, tool] of SERVERS) {
    try {
      const r = await $.mcp.call(server, tool, {})
      const s: any = r?.structuredContent
      if (r?.isError || !s || typeof s.level !== 'number') continue
      level = { n: s.level, advice: [s.advice, s.note].filter(Boolean).join(' '), at: now }
      return level
    } catch {}
  }
  return level // the last one read, if Leanfare stopped answering
}

// Leanfare's helper tool, where it answers (as its level tool, above).
const HELPER: [server: string, tool: string][] = [['leanfare', 'helper'], ['remote-devices', 'leanfare__helper']]
let helperAt: [string, string] | null = null
async function helper($: any, args: Record<string, unknown>): Promise<any | null> {
  for (const [server, tool] of helperAt ? [helperAt] : HELPER) {
    try {
      const r = await $.mcp.call(server, tool, args)
      if (r?.isError) continue
      helperAt = [server, tool]
      return r?.structuredContent ?? null
    } catch {}
  }
  return null
}
// The helpers Leanfare picked a model for, by their agent id, until they end.
const started: Record<string, { id: number; at: number }> = {}
const tokensOf = (u: any) => ({ input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), cached: u?.cache_read_input_tokens ?? 0, output: u?.output_tokens ?? 0 })

export const register: Register = on => {
  // A hook that fails lets everything through: Leanfare is never in the way.
  on('prompt.submit', ($, e, next) => { prompt++; return next(e) }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const l = await readLevel($)
    if (!l || l.n < 2) return r
    return { sections: [...r.sections.filter(x => x.id !== 'leanfare:level'), { id: 'leanfare:level', text: levelSection(l), scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (/leanfare__plan$/.test(tool)) { planned = prompt; return next(e) }
    if (/leanfare/i.test(tool) || QUIET.test(tool) || (e as any).agentId) return next(e)
    if (prompt === 0 || planned === prompt || gated === prompt) return next(e)
    const l = await readLevel($)
    if (!l || l.n < 4) return next(e)
    gated = prompt
    return { deny: firstWords(l.n) }
  }).catch(($, e, next) => next(e))

  // 3. A helper about to start: Leanfare's model for it. A fork keeps the parent's model, as Claude has it.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork) return next(e)
    const pick = await helper($, { task: String(e.prompt ?? '').slice(0, 8000), description: e.description, agent: e.subagentType, ...(e.model ? { asked: e.model } : {}) })
    const r: any = await next(pick?.model ? { ...e, model: pick.model } : e)
    if (pick?.id && r?.agentId) started[r.agentId] = { id: pick.id, at: Date.now() }
    return r
  }).catch(($, e, next) => next(e))

  // Its end, and the main model's own turns: the model and token counts, for Leanfare's report.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u: any = (e as any).usage
    if (!u) return r
    const id = (e as any).agentId as string | undefined
    const h = id ? started[id] : undefined
    if (h && id) { delete started[id]; void helper($, { done: { id: h.id, model: u.model, ...tokensOf(u), seconds: (Date.now() - h.at) / 1000, reason: (e as any).reason } }) }
    else if (!id) void helper($, { turn: { model: u.model, ...tokensOf(u) } })
    return r
  }).catch(($, e, next) => next(e))
}
