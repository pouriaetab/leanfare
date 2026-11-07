import { expect, test } from 'claude-code/testing'

const LINE = "Leanfare now: level 4, on. Leanfare: level 4 (Most) in this chat. It is set so the user's Claude plan lasts longer."
const TOOLS = [
  { name: 'mcp__remote-devices__leanfare__level', description: `${LINE}\n\nHow much to hand to Leanfare first.`, mcp: true },
  { name: 'mcp__remote-devices__leanfare__plan', description: 'Split a task across models.', mcp: true },
  { name: 'mcp__remote-devices__leanfare__delegate', description: 'Hand a job to another model.', mcp: true },
]
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} } as any

test('the row: four pickers, Off turns back every Leanfare call, and a pick is told to the model', async ($, on) => {
  const appended: string[] = []
  const reached: any[] = []
  const stored: Record<string, unknown> = {}
  on('tool.list', () => ({ value: TOOLS }))
  on('store.get', (_: any, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: any, e: any) => { stored[e.key] = e.value; return { value: undefined } })
  on('session.append', (_: any, e: any, next: any) => { appended.push(e.message.content[0].text); return next(e) })
  on('tool.call', (_: any, e: any) => { reached.push(e); return { result: { content: [{ type: 'text', text: 'ok' }] } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }) as any)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'leanfare-level', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const selects = await ui.findAll({ type: 'Select' })
  expect(selects.length).toBe(4)
  expect((await ui.find({ type: 'Text', text: /Leanfare/ }))?.text).toBe('Leanfare')

  await ui.select({ key: 'leanfare-level', value: 'off' })
  expect(appended.at(-1)).toContain('Leanfare is off in this chat')
  expect(stored.row).toMatchObject({ level: 'off' })
  const denied: any = await $.tool.call({ tool: 'mcp__remote-devices__leanfare__plan', task: 'x' } as any)
  expect(denied.deny).toContain('Leanfare is off in this chat')
  expect(reached.length).toBe(0)

  await ui.select({ key: 'leanfare-level', value: '3' })
  await ui.select({ key: 'leanfare-speed', value: 'fastest' })
  await ui.select({ key: 'leanfare-quality', value: 'high' })
  await ui.select({ key: 'leanfare-only', value: 'claude' })
  expect(appended.at(-1)).toContain('level 3 (More)')
  expect(appended.at(-1)).toContain('Claude only')
  await $.tool.call({ tool: 'mcp__remote-devices__leanfare__plan', task: 'x' } as any)
  expect(reached.at(-1)).toMatchObject({ level: 3, speed: 'fastest', split: 'rules', quality: 'high', only: 'claude' })
  const no: any = await $.tool.call({ tool: 'mcp__remote-devices__leanfare__delegate', task: 'y' } as any)
  expect(no.deny).toContain('Claude only in this chat')
  await ui.unmount()
})

test('no Leanfare tools here: no row', async ($, on) => {
  on('tool.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, null, 'engine') })
  const ui = await $.ui.mount({ plugin: 'leanfare-level', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.findAll({ type: 'Select' })).toEqual([])
  await ui.unmount()
})
