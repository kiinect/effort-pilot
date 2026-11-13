import { expect, test } from 'claude-code/testing'
import { classify, trimOutput } from '../hooks/classify'

const step = (effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', index = 0) =>
  ({ turnId: 't1', index, model: 'claude-opus-5-5', effort, messageCount: 1 }) as const

// Stand-ins for the engine beneath the plugin.
function engine(on: any, answers: string[] = []) {
  const sent: (string | number | undefined)[] = []
  const asked: string[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { name: 'set_effort' } }))
  on('command.register', () => ({ value: { command: 'pilot' } }))
  on('config.list', () => ({ value: [] }))
  on('config.set', () => ({ value: {} }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    const q = e.questions[0].question
    asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: answers.shift() ?? 'Keep high' } } }
  })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId ?? 't1' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_: any, e: any) {
    sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { sent, asked }
}

async function drain(stream: any) {
  for await (const _ of stream) { /* chunks */ }
  return stream.result
}

async function runPrompt($: any, text: string) {
  await $.prompt.submit({ text })
  await $.turn.start({ turnId: 't1' } as any)
  await drain($.turn.step(step('high', 0)))
  await drain($.turn.step(step('high', 1)))
  await $.turn.complete({ turnId: 't1', reason: 'completed', durationMs: 1, answer: '' } as any)
}

test('classifier: routine → low, follow-up → keep, hard → high, explicit → max', () => {
  expect(classify('run the tests')?.level).toBe('low')
  expect(classify('git status')?.level).toBe('low')
  expect(classify('rename foo to bar in utils.py')?.level).toBe('low')
  expect(classify('yes')).toBe(null)
  expect(classify('continue')).toBe(null)
  expect(classify('debug why the websocket reconnect loop leaks memory after a server restart')?.level).toBe('high')
  expect(classify('ultrathink: is this lock-free queue correct?')?.level).toBe('max')
  expect(classify('ultrathink: is this lock-free queue correct?', { max: 'xhigh' })?.level).toBe('xhigh')
})

test('trimOutput keeps head and tail, reports the cut', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
  const t = trimOutput(big, 1000)!
  expect(t.text.startsWith('line 0')).toBe(true)
  expect(t.text.endsWith('line 1999')).toBe(true)
  expect(t.text.length < 1200).toBe(true)
  expect(trimOutput('short', 1000)).toBe(null)
})

test('approved pick rewrites every main-loop step of the turn', async ($, on) => {
  const { sent, asked } = engine(on, ['Use low'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await drain($.turn.step(step('high'))) // learn the session baseline
  sent.length = 0
  await runPrompt($, 'run the tests')
  expect(asked.length).toBe(1)
  expect(sent).toEqual(['low', 'low'])
})

test('declined pick leaves effort alone', async ($, on) => {
  const { sent } = engine(on, ['Keep high'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await runPrompt($, 'run the tests')
  expect(sent).toEqual(['high', 'high'])
})

test('auto-approve applies without asking', { options: { autoApprove: true } }, async ($, on) => {
  const { sent, asked } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await runPrompt($, 'run the tests')
  expect(asked.length).toBe(0)
  expect(sent).toEqual(['low', 'low'])
})

test("Claude's set_effort needs approval, then applies from the next step", async ($, on) => {
  const { sent } = engine(on, ['Allow medium'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  await $.prompt.submit({ text: 'continue' } as any)
  await $.turn.start({ turnId: 't1' } as any)
  await drain($.turn.step(step('high', 0)))
  const r: any = await $.tool.call({ tool: 'mcp__effort-pilot__set_effort', level: 'medium', reason: 'only renames left' } as any)
  expect(String(r.result ?? r.text)).toContain('medium')
  await drain($.turn.step(step('high', 1)))
  expect(sent).toEqual(['high', 'medium'])
})

test('big Bash output is trimmed and spilled to a file', { options: { trimBashChars: 500 } }, async ($, on) => {
  engine(on)
  const written: string[] = []
  on('fs.write', (_: any, e: any) => { written.push(e.path ?? String(e)); return { value: undefined } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'x\n'.repeat(5000), stderr: '', interrupted: false } }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'make' } as any)
  expect(String(r.result.stdout).length < 700).toBe(true)
  expect(written.length).toBe(1)
})
