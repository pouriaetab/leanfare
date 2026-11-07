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
// Cowork asks before every call to Leanfare. So the mod calls Leanfare only on Leanfare's own server, never through the
// link, and reads the level from the first line of the level tool's description, which Leanfare writes when it lists
// its tools and lists again when the level changes. Leanfare's own answers ("switched off") count at once.
// 0.15.4: the Leanfare row, just above the message box (his ask, 6 Nov 2026: "a button where ... '+' etc are"): the
// level for this chat (Leanfare's knob, Off, 2 to 5), the speed (as in Leanfare, fast, balanced, cheapest), the
// quality (standard or high) and the models (Claude and Leanfare's, or Claude only). A pick calls nothing: the mod
// shapes Claude's own calls to Leanfare by it, refuses them all when Off (so nothing is asked), and tells the model in
// a row of the conversation it reads. The picks are kept for the next chat where the app keeps the mod's store.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Row } from '../types'

declare const h: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown

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
const NAMES: Record<number, string> = { 1: 'Off', 2: 'Light', 3: 'More', 4: 'Most', 5: 'All it can' }
// When the description's advice did not come through (an app may show a tool's first sentence only), or for a level
// the row sets.
const ADVICE: Record<number, string> = {
  2: 'Hand big reads you will not change and tasks with several parts to Leanfare (delegate, plan).',
  3: 'Hand reads over about 10 KB you will not change, project wide searches, summaries, reviews and first drafts to Leanfare (delegate), and plan tasks with several parts.',
  4: "Unless the prompt is a quick question, make Leanfare's plan tool your first tool call, with your own split in parts, and follow its table.",
  5: "Make Leanfare's plan tool your first tool call for each prompt, with no parts: Leanfare makes the split; you review, decide and answer.",
}

// The row (0.15.4): its choices, as the session holds them.
export const ROW: Row = { level: 'knob', speed: 'app', quality: 'standard', only: 'any' }
const row = atom({ plugin: 'leanfare-level', key: 'row' } as const, ROW)
const CHOICES: { [K in keyof Row]: { label: string; options: { value: Row[K]; label: string }[] } } = {
  level: { label: 'Level', options: [{ value: 'knob', label: "Leanfare's knob" }, { value: 'off', label: 'Off' }, { value: '2', label: '2 Light' }, { value: '3', label: '3 More' }, { value: '4', label: '4 Most' }, { value: '5', label: '5 All it can' }] },
  speed: { label: 'Speed', options: [{ value: 'app', label: 'As in Leanfare' }, { value: 'fastest', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }, { value: 'cheapest', label: 'Cheapest' }] },
  quality: { label: 'Quality', options: [{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }] },
  only: { label: 'Models', options: [{ value: 'any', label: "Claude and Leanfare's" }, { value: 'claude', label: 'Claude only' }] },
}
export const isRow = (x: any): x is Row => !!x && typeof x === 'object' && (Object.keys(CHOICES) as (keyof Row)[]).every(k => CHOICES[k].options.some(o => o.value === x[k]))
const word = <K extends keyof Row>(k: K, v: Row[K]) => CHOICES[k].options.find(o => o.value === v)?.label ?? String(v)

type Level = { n: number; advice: string; at: number; from: 'list' | 'own' | 'answer'; line?: string; off?: boolean }
let level: Level | null = null
let lastLine: string | undefined // the line as last listed
let described: string | undefined // the line as the engine first described the level tool
let ownTried = 0
let own: { is: boolean; at: number } | null = null
let linked: { is: boolean; at: number } | null = null
let prompt = 0, planned = -1, gated = -1

export const firstWords = (n: number) =>
  `Leanfare: level ${n} in this chat, so plan first: call Leanfare's plan tool (its name ends in leanfare__plan)${n === 4 ? ' with your own split in parts' : ', and Leanfare makes the split'}, then follow its table; it starts Leanfare's parts by itself. If this prompt is a quick question, go on: this call goes through when you make it again.`
export const levelSection = (l: { advice: string }) =>
  `${l.advice} Leanfare's tools have names ending in leanfare__plan, leanfare__delegate and so on: if they are deferred, load them in one ToolSearch call (+leanfare). End your reply with one line on what Leanfare did this turn.`
export const OFF_HERE = 'Leanfare is off in this chat (the Leanfare row above the message box): do not call or load its tools, and do the work yourself.'
export const CLAUDE_ONLY = "Claude only in this chat (the Leanfare row above the message box): nothing goes to outside models. Do this yourself, or on a helper with the Claude model Leanfare's plan names."

// The level from a description's first line: off is level 1.
export function fromLine(description: unknown): { n: number; advice: string; line: string; off: boolean } | null {
  const m = NOW.exec(String(description ?? ''))
  if (!m) return null
  const off = m[2] === 'switched off', n = off ? 1 : Number(m[1])
  return { n, advice: m[3]?.trim() || ADVICE[n] || `Leanfare: level ${n}.`, line: m[0], off }
}

async function tools($: any): Promise<any[]> {
  try { return ((await $.tool.list()) ?? []) as any[] } catch { return [] }
}
// Leanfare's level tool as this session lists it, on its own server or through the link. No call.
async function listed($: any) {
  for (const t of await tools($)) if (/leanfare__level$/.test(String(t?.name))) { const l = fromLine(t?.description); if (l) return l }
  return described ? fromLine(described) : null
}
// Whether Leanfare's own server is in this session (its tools are mcp__leanfare__...), read again each minute.
async function ownServer($: any): Promise<boolean> {
  const now = Date.now()
  if (own && now - own.at < RELIST) return own.is
  own = { is: (await tools($)).some((t: any) => /^mcp__leanfare__/.test(String(t?.name))), at: now }
  return own.is
}
// Whether Leanfare's tools are here at all (its own server or the link): the row shows only then.
async function present($: any): Promise<boolean> {
  const now = Date.now()
  if (linked && now - linked.at < RELIST) return linked.is
  linked = { is: (await tools($)).some((t: any) => /leanfare__level$/.test(String(t?.name))) || !!described, at: now }
  return linked.is
}

async function readLevel($: any): Promise<Level | null> {
  const now = Date.now()
  if (level && now - level.at < (level.from === 'own' ? REREAD : RELIST)) return level
  const l = await listed($)
  if (l) {
    lastLine = l.line
    // Leanfare's own answer since the list was made ("switched off") holds until the list says something new.
    if (level?.from === 'answer' && level.line === l.line) { level = { ...level, at: now }; return level }
    level = { n: l.n, advice: l.advice, at: now, from: 'list', line: l.line, off: l.off }
    return level
  }
  // No line (an older Leanfare): ask Leanfare's own server, which asks the person nothing; never the link.
  if (now - ownTried >= 60_000 && (await ownServer($))) {
    ownTried = now
    try {
      const r = await $.mcp.call(OWN, 'level', {})
      const s: any = r?.structuredContent
      if (!r?.isError && s && typeof s.level === 'number') {
        level = { n: s.level, advice: [s.advice, s.note].filter(Boolean).join(' '), at: now, from: 'own', off: s.off === true }
        return level
      }
    } catch {}
  }
  return level
}

// The level in effect here: the row's own, else Leanfare's knob. off: nothing of Leanfare's runs in this chat.
export async function inEffect($: any): Promise<{ n: number; advice: string; off: boolean; row: Row } | null> {
  const r: Row = await read($, row)
  if (r.level === 'off') return { n: 1, advice: OFF_HERE, off: true, row: r }
  const l = await readLevel($)
  if (r.level !== 'knob') { const n = Number(r.level); return { n, advice: l && l.n === n && !l.off ? l.advice : `Leanfare: level ${n} (${NAMES[n]}) in this chat, as the Leanfare row says. ${ADVICE[n]}`, off: false, row: r } }
  return l ? { n: l.n, advice: l.advice, off: !!l.off, row: r } : null
}

// What the row adds to the level's words, when it is not at its defaults.
export function rowWords(r: Row): string {
  const said = [r.speed !== 'app' ? `speed ${word('speed', r.speed).toLowerCase()}` : '', r.quality === 'high' ? 'quality high (each part one effort step up)' : '', r.only === 'claude' ? 'Claude only (nothing to outside models; delegate and ask are turned back)' : ''].filter(Boolean)
  return said.length ? ` The Leanfare row also says: ${said.join(', ')}. Leanfare's calls carry it.` : ''
}
// The row in words for the model, when it changes during a chat.
export function rowNote(e: { n: number; advice: string; off: boolean; row: Row } | null): string {
  if (!e) return "The Leanfare row above the message box now follows Leanfare's knob, which this chat cannot read yet: use Leanfare only when the user asks."
  if (e.off) return `${OFF_HERE} This replaces any Leanfare level said before in this chat.`
  return `The Leanfare row above the message box now says: level ${e.n} (${NAMES[e.n]}). Follow it from here, in place of any Leanfare level said before in this chat. ${e.n >= 2 ? e.advice : 'Use Leanfare only when the user asks.'}${rowWords(e.row)}`
}

// Claude's own call to Leanfare, shaped by the row: the level, the speed (fast splits by rules, with no model call),
// the quality, and Claude only.
export function shaped(tool: string, e: any, r: Row): any {
  const x: any = { ...e }
  const kind = /leanfare__(\w+)$/.exec(tool)?.[1]
  if ((kind === 'plan' || kind === 'delegate') && r.level !== 'knob' && r.level !== 'off') x.level = Number(r.level)
  if (kind === 'plan') {
    if (r.speed !== 'app') { x.speed = r.speed; if (r.speed === 'fastest') x.split = 'rules' }
    if (r.quality === 'high') x.quality = 'high'
    if (r.only === 'claude') x.only = 'claude'
  }
  if (kind === 'delegate' || kind === 'ask') {
    if (r.speed !== 'app') x.speed = r.speed
    if (r.quality === 'high') x.effort = 'high'
  }
  return x
}

// A pick on the row: kept for the session and the next chat, and said to the model.
async function choose($: any, key: keyof Row, value: string) {
  let now: Row = ROW
  await update($, row, (r: Row) => (now = isRow({ ...r, [key]: value }) ? ({ ...r, [key]: value } as Row) : r))
  try { await $.store.set('row', now) } catch {}
  gated = prompt // a pick is not a prompt: no plan-first turn back until the next one
  try { await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: rowNote(await inEffect($)) }] } }) } catch {}
}

// What Leanfare said to Claude's own call: switched off, or a level it set. The gate follows at once, with no call.
function heard(tool: string, r: any) {
  let s = ''
  try { s = JSON.stringify(r?.result ?? r ?? '') } catch { return }
  if (OFF.test(s)) { level = { n: 1, advice: '', at: Date.now(), from: 'answer', line: lastLine, off: true }; return }
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
  // The row as the last chat left it, where the app keeps the mod's store.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try { const kept = await $.store.get('row'); if (isRow(kept)) await update($, row, () => kept) } catch {}
    return r
  }).catch(($, e, next) => next(e))

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
    const l = await inEffect($)
    if (!l || l.n < 2) return r
    return { sections: [...r.sections.filter(x => x.id !== 'leanfare:level'), { id: 'leanfare:level', text: levelSection(l) + rowWords(l.row), scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (/leanfare__/.test(tool)) {
      const l = await inEffect($)
      // Off in the row, or Leanfare switched off: turned back here, so Cowork asks nothing.
      if (l?.off) return { deny: l.row.level === 'off' ? OFF_HERE : 'Leanfare is switched off in the Leanfare app: do not call or load its tools in this chat, and do the work yourself.' }
      const r = l?.row ?? ROW
      if (r.only === 'claude' && /leanfare__(delegate|ask)$/.test(tool)) return { deny: CLAUDE_ONLY }
      if (/leanfare__plan$/.test(tool)) planned = prompt
      const out = await next(shaped(tool, e, r))
      heard(tool, out)
      return out
    }
    if (QUIET.test(tool) || (e as any).agentId) return next(e)
    if (prompt === 0 || planned === prompt || gated === prompt) return next(e)
    const l = await inEffect($)
    if (!l || l.off || l.n < 4) return next(e)
    gated = prompt
    return { deny: firstWords(l.n) }
  }).catch(($, e, next) => next(e))

  // The row, above the message box: four pickers. Shown while Leanfare's tools are here; a survey goes first.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e as any).props?.hasSurvey || !(await present($))) return next(e)
    const r: Row = await read($, row)
    const knob = r.level === 'knob' ? await readLevel($) : null
    const { Box, Text, Select } = $.ui.resolve(e) as any
    const pick = (k: keyof Row) => h(Select, {
      key: `leanfare-${k}`,
      label: CHOICES[k].label,
      value: r[k],
      options: CHOICES[k].options.map(o => (k === 'level' && o.value === 'knob' && knob ? { ...o, label: `Leanfare's knob (${knob.off ? 'switched off' : knob.n})` } : o)),
      onSelect: (v: string) => choose($, k, v),
    })
    return h(Box, { flexDirection: 'row', gap: 1, alignItems: 'center', flexWrap: 'wrap' }, h(Text, { dimColor: true }, 'Leanfare'), pick('level'), pick('speed'), pick('quality'), pick('only'))
  })

  // 3. A helper about to start: Leanfare's model for it, on Leanfare's own server only. A fork keeps the parent's model.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || !(await ownServer($))) return next(e)
    const l = await inEffect($)
    if (l?.off) return next(e) // off here: no call to Leanfare
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
    const h0 = id ? started[id] : undefined
    if (h0 && id) { delete started[id]; void helper($, { done: { id: h0.id, model: u.model, ...tokensOf(u), seconds: (Date.now() - h0.at) / 1000, reason: (e as any).reason } }) }
    else if (!id) void helper($, { turn: { model: u.model, ...tokensOf(u) } })
    return r
  }).catch(($, e, next) => next(e))
}
