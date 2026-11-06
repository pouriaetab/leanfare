// Leanfare's level in Cowork and Claude Desktop (0.14.1). These apps show Leanfare's tools to the model by name only and
// never its own instructions, and they have no prompt hook for an outside program, so a chat learned the level only if
// it happened to call Leanfare's level tool. This mod runs inside the app:
//   1. the level goes into the system prompt, so the knob in Leanfare holds in every chat;
//   2. at levels 4 and 5 the first tool call of a prompt that is not Leanfare's plan is turned back once, with the
//      reason, and the next one goes through (Claude Code's plan first hook does the same);
//   3. (0.15) where Leanfare answers on its own server, each helper (subagent) Claude starts runs on the Claude model
//      Leanfare picks for it, and at a helper's end and at each of the main model's turns the model and its token
//      counts go to Leanfare for its report: numbers only, never words.
// 0.15.3: it asks the person nothing. Through the desktop app's link to the computer (a Cowork task in the cloud),
// Cowork asks before every call to Leanfare, with no "always allow": reading the level every 10 minutes, a model for
// each helper and each turn's numbers made over 10 questions in one task (5 Nov 2026). So the mod calls Leanfare only
// on Leanfare's own server, never through the link, and reads the level from the first line of the level tool's
// description: Leanfare writes it when it lists its tools and lists them again when the level changes. Leanfare's own
// answers ("switched off") count at once. Without Leanfare connected it does nothing.
import type { Register } from 'claude-code'

// Leanfare's own server (the app runs it): a call there asks the person nothing.
const OWN = 'leanfare'
const REREAD = 10 * 60_000 // the level from Leanfare's own server, read again
const RELIST = 60_000 // the level from the tool list (no call), read again
// The first line of the level tool's description (0.15.3): the level now, whether Leanfare is on, and the advice.
export const NOW = /^Leanfare now: level ([1-5]), (on|switched off)\.(?: ([^\n]*))?/
// Leanfare's answer when it is switched off, at the start of a tool's text.
const OFF = /"text":"Leanfare is switched off/
// Tools that only look things up or keep the task list: never turned back.
const QUIET = /^(ToolSearch|Skill|TaskCreate|TaskUpdate|TaskList|TaskGet|TodoWrite|AskUserQuestion|SendUserMessage|ExitPlanMode|EnterPlanMode)$/
// When the description's advice did not come through (an app may show a tool's first sentence only).
const ADVICE: Record<number, string> = {
  2: 'Hand big reads you will not change and tasks with several parts to Leanfare (delegate, plan).',
  3: 'Hand reads over about 10 KB you will not change, project wide searches, summaries, reviews and first drafts to Leanfare (delegate), and plan tasks with several parts.',
  4: "Unless the prompt is a quick question, make Leanfare's plan tool your first tool call, with your own split in parts, and follow its table.",
  5: "Make Leanfare's plan tool your first tool call for each prompt, with no parts: Leanfare makes the split; you review, decide and answer.",
}

type Level = { n: number; advice: string; at: number; from: 'list' | 'own' | 'answer'; line?: string }
let level: Level | null = null
let lastLine: string | undefined // the line as last listed
let described: string | undefined // the line as the engine first described the level tool
let ownTried = 0
let own: { is: boolean; at: number } | null = null
let prompt = 0, planned = -1, gated = -1

export const firstWords = (n: number) =>
  `Leanfare: level ${n} in this chat, so plan first: call Leanfare's plan tool (its name ends in leanfare__plan)${n === 4 ? ' with your own split in parts' : ', and Leanfare makes the split'}, then follow its table; it starts Leanfare's parts by itself. If this prompt is a quick question, go on: this call goes through when you make it again.`
export const levelSection = (l: { advice: string }) =>
  `${l.advice} Leanfare's tools have names ending in leanfare__plan, leanfare__delegate and so on: if they are deferred, load them in one ToolSearch call (+leanfare). End your reply with one line on what Leanfare did this turn.`

// The level from a description's first line: off is level 1.
export function fromLine(description: unknown): { n: number; advice: string; line: string } | null {
  const m = NOW.exec(String(description ?? ''))
  if (!m) return null
  const n = m[2] === 'switched off' ? 1 : Number(m[1])
  return { n, advice: m[3]?.trim() || ADVICE[n] || `Leanfare: level ${n}.`, line: m[0] }
}

// Leanfare's level tool as this session lists it, on its own server or through the link. No call.
async function listed($: any) {
  try {
    const tools: any[] = await $.tool.list()
    for (const t of tools ?? []) if (/leanfare__level$/.test(String(t?.name))) { const l = fromLine(t?.description); if (l) return l }
  } catch {}
  return described ? fromLine(described) : null
}

// Whether Leanfare's own server is in this session (its tools are mcp__leanfare__...), read again each minute.
async function ownServer($: any): Promise<boolean> {
  const now = Date.now()
  if (own && now - own.at < RELIST) return own.is
  let is = false
  try { is = ((await $.tool.list()) ?? []).some((t: any) => /^mcp__leanfare__/.test(String(t?.name))) } catch {}
  own = { is, at: now }
  return is
}

async function readLevel($: any): Promise<Level | null> {
  const now = Date.now()
  if (level && now - level.at < (level.from === 'own' ? REREAD : RELIST)) return level
  const l = await listed($)
  if (l) {
    lastLine = l.line
    // Leanfare's own answer since the list was made ("switched off") holds until the list says something new.
    if (level?.from === 'answer' && level.line === l.line) { level = { ...level, at: now }; return level }
    level = { n: l.n, advice: l.advice, at: now, from: 'list', line: l.line }
    return level
  }
  // No line (an older Leanfare): ask Leanfare's own server, which asks the person nothing; never the link.
  if (now - ownTried >= 60_000 && (await ownServer($))) {
    ownTried = now
    try {
      const r = await $.mcp.call(OWN, 'level', {})
      const s: any = r?.structuredContent
      if (!r?.isError && s && typeof s.level === 'number') {
        level = { n: s.level, advice: [s.advice, s.note].filter(Boolean).join(' '), at: now, from: 'own' }
        return level
      }
    } catch {}
  }
  return level
}

// What Leanfare said to Claude's own call: switched off, or a level it set. The gate follows at once, with no call.
function heard(tool: string, r: any) {
  let s = ''
  try { s = JSON.stringify(r?.result ?? r ?? '') } catch { return }
  if (OFF.test(s)) { level = { n: 1, advice: '', at: Date.now(), from: 'answer', line: lastLine }; return }
  const m = /leanfare__level$/.test(tool) ? /Leanfare: level ([1-5])\b/.exec(s) : null
  if (m) { const n = Number(m[1]); level = { n, advice: ADVICE[n] ?? '', at: Date.now(), from: 'answer', line: lastLine } }
}

// Leanfare's helper tool, on its own server only.
async function helper($: any, args: Record<string, unknown>): Promise<any | null> {
  try {
    const r = await $.mcp.call(OWN, 'helper', args)
    return r?.isError ? null : r?.structuredContent ?? null
  } catch { return null }
}
// The helpers Leanfare picked a model for, by their agent id, until they end.
const started: Record<string, { id: number; at: number }> = {}
const tokensOf = (u: any) => ({ input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), cached: u?.cache_read_input_tokens ?? 0, output: u?.output_tokens ?? 0 })

export const register: Register = on => {
  // A hook that fails lets everything through: Leanfare is never in the way.
  on('prompt.submit', ($, e, next) => { prompt++; return next(e) }).catch(($, e, next) => next(e))

  // The level tool's description as the engine first shows it: its first line says the level.
  on('tool.describe', async ($, e, next) => {
    const r: any = await next(e)
    if (/leanfare__level$/.test(String(e.tool)) && NOW.test(String(r?.description ?? e.description ?? ''))) described = String(r?.description ?? e.description)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const l = await readLevel($)
    if (!l || l.n < 2) return r
    return { sections: [...r.sections.filter(x => x.id !== 'leanfare:level'), { id: 'leanfare:level', text: levelSection(l), scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (/leanfare__/.test(tool)) {
      if (/leanfare__plan$/.test(tool)) planned = prompt
      const r = await next(e)
      heard(tool, r)
      return r
    }
    if (QUIET.test(tool) || (e as any).agentId) return next(e)
    if (prompt === 0 || planned === prompt || gated === prompt) return next(e)
    const l = await readLevel($)
    if (!l || l.n < 4) return next(e)
    gated = prompt
    return { deny: firstWords(l.n) }
  }).catch(($, e, next) => next(e))

  // 3. A helper about to start: Leanfare's model for it, on Leanfare's own server only. A fork keeps the parent's model.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || !(await ownServer($))) return next(e)
    const pick = await helper($, { task: String(e.prompt ?? '').slice(0, 8000), description: e.description, agent: e.subagentType, ...(e.model ? { asked: e.model } : {}) })
    const r: any = await next(pick?.model ? { ...e, model: pick.model } : e)
    if (pick?.id && r?.agentId) started[r.agentId] = { id: pick.id, at: Date.now() }
    return r
  }).catch(($, e, next) => next(e))

  // Its end, and the main model's own turns: the model and token counts, for Leanfare's report (own server only).
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const u: any = (e as any).usage
    if (!u || !(await ownServer($))) return r
    const id = (e as any).agentId as string | undefined
    const h = id ? started[id] : undefined
    if (h && id) { delete started[id]; void helper($, { done: { id: h.id, model: u.model, ...tokensOf(u), seconds: (Date.now() - h.at) / 1000, reason: (e as any).reason } }) }
    else if (!id) void helper($, { turn: { model: u.model, ...tokensOf(u) } })
    return r
  }).catch(($, e, next) => next(e))
}
