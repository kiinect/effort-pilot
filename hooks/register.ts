import type { EngineInterface, Register } from 'claude-code'
import { classify, clampLevel, isLevel, parseLevel, rank, trimOutput, type Level } from './classify'

type Plan = { level: Level; reason: string; by: 'pilot' | 'claude' }
type Stats = {
  turns: Record<string, number>
  outputTokens: Record<string, number>
  suggested: number
  accepted: number
  declined: number
  claudeSwitches: number
  bashCharsTrimmed: number
  readsGuarded: number
}

const TOOL = 'set_effort'
const LEAN_RULES = [
  'Lean work (effort-pilot): send independent tool calls together in one message;',
  'locate with Grep/Glob before reading, and read big files by offset/limit;',
  'never re-read a file you just wrote or restate tool output back;',
  'answer with the result first, changed parts only. These rules cut tokens, never quality: when unsure, verify.',
].join(' ')

const emptyStats = (): Stats => ({
  turns: {}, outputTokens: {}, suggested: 0, accepted: 0, declined: 0,
  claudeSwitches: 0, bashCharsTrimmed: 0, readsGuarded: 0,
})

async function saveStats($: EngineInterface, stats: Stats) {
  try { await $.store.set('stats', stats) } catch {}
}

function showStatus($: EngineInterface, baseline: Level | null, active: Plan | null) {
  $.ui.status(active && baseline && active.level !== baseline ? `effort ${baseline}→${active.level}` : undefined)
}

/** Ask the person; resolves the label, or null if dismissed or headless. */
async function askPerson($: EngineInterface, q: string, opts: string[]): Promise<string | null> {
  try { return await $.ui.ask(q, { header: 'Effort', options: opts }) } catch { return null }
}

async function turnOnAuto($: EngineInterface) {
  try { await $.config.set({ key: `${$.plugin.name}.autoApprove`, value: true }) } catch { $.ui.toast('Could not save auto-approve; use /config.') }
}

export const register: Register = (on, options) => {
  const o = {
    autoApprove: options.autoApprove === true,
    classifier: options.classifier === 'hybrid' ? 'hybrid' : 'heuristic',
    min: isLevel(options.minLevel) ? options.minLevel : 'low',
    max: isLevel(options.maxLevel) ? options.maxLevel : 'xhigh',
    trimBash: typeof options.trimBashChars === 'number' ? options.trimBashChars : 8000,
    readGuard: typeof options.readGuardLines === 'number' ? options.readGuardLines : 800,
    lean: options.leanPrompt !== false,
    spillDir: typeof options.spillDir === 'string' && options.spillDir ? options.spillDir : '/tmp/effort-pilot',
  } as const

  let enabled = true
  let baseline: Level | null = null // the session's own effort, as the last un-rewritten step showed it
  let pending: Plan | null = null // chosen at prompt.submit, applied from the next main turn
  let active: Plan | null = null // in force for the running main turn
  let mainTurn: string | null = null
  let spillN = 0
  const guarded = new Set<string>()
  let stats: Stats = emptyStats()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const s = (await $.store.get('stats').catch(() => null)) as Stats | null
    if (s && typeof s === 'object') stats = { ...emptyStats(), ...s }
    try {
      const row = (await $.config.list()).find((x: any) => /^effort(level)?$/i.test(String(x.key)))
      const v = (row as any)?.value
      if (isLevel(v)) baseline = v
    } catch {}
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Switch your reasoning effort for the rest of this turn. Use it when the remaining work is clearly ' +
        'easier than the effort in force (mechanical edits, running known commands, formatting) or clearly ' +
        'harder (a subtle bug you are stuck on, a design decision). Never lower effort for anything that ' +
        'needs judgment. The person approves unless they turned on auto-approve.',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
          reason: { type: 'string', description: 'One short line: why this level fits the remaining work.' },
        },
        required: ['level', 'reason'],
      },
    })
    await $.command.register({
      name: 'pilot',
      description: 'effort-pilot: status | auto on|off | on | off | stats reset',
      argumentHint: '[auto on|off | on | off | stats reset]',
    })
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!o.lean) return r
    return { sections: [...r.sections, { id: 'effort-pilot:lean', text: LEAN_RULES, scope: 'session' as const }] }
  })

  // 1. Pick an effort for the prompt the person just sent.
  on('prompt.submit', async ($, e, next) => {
    if (!enabled || e.command || e.isMeta) return next(e)
    let v = classify(e.text, { min: o.min, max: o.max })
    if (v && v.confidence === 'unsure' && o.classifier === 'hybrid') {
      try {
        const r: any = await $.model.complete({
          model: 'haiku',
          effort: 'low',
          timeoutMs: 6000,
          prompt:
            'How much reasoning effort does a strong coding agent need for this request? ' +
            'Reply with one word: low, medium, high or xhigh.\n\n<request>\n' + e.text.slice(0, 4000) + '\n</request>',
        })
        const lvl = r?.isAnswered ? parseLevel(String(r.text ?? '')) : null
        if (lvl) v = { level: clampLevel(lvl, o.min, o.max), confidence: 'sure', reason: `${v.reason}; Haiku: ${lvl}` }
      } catch {}
    }
    pending = null
    if (!v) return next(e) // a follow-up: keep whatever is in force
    const current = baseline ?? 'high'
    if (v.level === current) return next(e)
    stats.suggested++
    const plan: Plan = { level: v.level, reason: v.reason, by: 'pilot' }
    if (o.autoApprove) {
      pending = plan
      stats.accepted++
    } else {
      const use = `Use ${v.level}`
      const keep = `Keep ${current}`
      const always = 'Always auto-apply'
      const pause = 'Stop for this session'
      const a = await askPerson($, `Effort ${current} → ${v.level} for this prompt? (${v.reason})`, [use, keep, always, pause])
      if (a === use || a === always) { pending = plan; stats.accepted++ }
      else stats.declined++
      if (a === always) await turnOnAuto($)
      if (a === pause) enabled = false
    }
    await saveStats($, stats)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurn = (e as any).turnId ?? null
      active = pending
      pending = null
    }
    return next(e)
  })

  // 2. Apply it on every main-loop request of the turn (a rewrite lasts one step).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (isLevel(e.effort)) baseline = e.effort
    const want = active?.level
    const sent = want && isLevel(e.effort) && want !== e.effort ? want : (isLevel(e.effort) ? e.effort : null)
    showStatus($, baseline, active)
    const r = yield* next(want && want !== e.effort ? { ...e, effort: want } : e)
    if (sent) {
      stats.outputTokens[sent] = (stats.outputTokens[sent] ?? 0) + Number((r as any)?.usage?.output_tokens ?? 0)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      const lvl = active?.level ?? baseline ?? 'default'
      stats.turns[lvl] = (stats.turns[lvl] ?? 0) + 1
      active = null
      mainTurn = null
      showStatus($, baseline, active)
      await saveStats($, stats)
    }
    return r
  })

  // 3. Claude asks to switch effort mid-turn (the "faster route" bypass).
  on('tool.call', { tool: 'mcp__effort-pilot__set_effort' }, async ($, e: any) => {
    const level = e.level
    const reason = String(e.reason ?? '').slice(0, 200)
    if (!isLevel(level)) return { result: `Unknown level ${String(level)}; use low|medium|high|xhigh|max.` }
    const current = active?.level ?? baseline ?? 'high'
    if (level === current) return { result: `Effort is already ${level}.` }
    if (!o.autoApprove) {
      const allow = `Allow ${level}`
      const always = 'Always allow'
      const a = await askPerson($, `Claude wants effort ${current} → ${level} for the rest of this turn: ${reason}`, [allow, `Keep ${current}`, always])
      if (a !== allow && a !== always) return { result: `The person kept effort at ${current}. Continue at ${current}.` }
      if (a === always) await turnOnAuto($)
    }
    active = { level, reason, by: 'claude' }
    stats.claudeSwitches++
    showStatus($, baseline, active)
    await saveStats($, stats)
    return { result: `Effort set to ${level} for the rest of this turn (from your next step).` }
  })

  // 4. Token savers that keep the full information reachable.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r: any = await next(e)
    if (o.trimBash <= 0 || r.deny !== undefined || !r.result) return r
    const stdout = String(r.result.stdout ?? '')
    const t = trimOutput(stdout, o.trimBash)
    if (!t) return r
    const path = `${o.spillDir}/bash-${Date.now().toString(36)}-${++spillN}.txt`
    try {
      await $.fs.write(path, stdout)
    } catch {
      return r // could not save the full output: hand it over untouched
    }
    stats.bashCharsTrimmed += t.cut
    return {
      result: { ...r.result, stdout: t.text },
      context: [`effort-pilot trimmed ${t.cut} chars from the middle of that output; the full ${stdout.length}-char output is at ${path} (Read/Grep it if the middle matters).`],
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e: any, next) => {
    if (o.readGuard <= 0 || e.offset !== undefined || e.limit !== undefined || e.pages !== undefined) return next(e)
    const path = String(e.file_path ?? '')
    if (!path || guarded.has(path) || /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb|svg)$/i.test(path)) return next(e)
    let lines = 0
    try {
      const text = String(await $.fs.read(path))
      lines = text.split('\n').length
    } catch {
      return next(e)
    }
    if (lines <= o.readGuard) return next(e)
    guarded.add(path)
    stats.readsGuarded++
    await saveStats($, stats)
    return {
      deny: `effort-pilot: ${path} has ${lines} lines. Grep for what you need and Read with offset/limit — or repeat this exact Read to get the whole file.`,
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'pilot' }, async ($, e) => {
    const a = e.args.trim().toLowerCase()
    if (a === 'auto on' || a === 'auto off') {
      await $.config.set({ key: `${$.plugin.name}.autoApprove`, value: a === 'auto on' })
      return { text: `effort-pilot: auto-approve ${a === 'auto on' ? 'ON — changes apply without asking' : 'OFF — you approve each change'}.` }
    }
    if (a === 'off' || a === 'on') {
      enabled = a === 'on'
      return { text: `effort-pilot: per-prompt picks ${enabled ? 'on' : 'paused for this session'}.` }
    }
    if (a === 'stats reset') { stats = emptyStats(); await saveStats($, stats); return { text: 'effort-pilot: stats reset.' } }
    const n = (r: Record<string, number>) =>
      Object.entries(r).sort((x, y) => (isLevel(x[0]) ? rank(x[0]) : 9) - (isLevel(y[0]) ? rank(y[0]) : 9))
        .map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'
    return {
      text: [
        `effort-pilot ${enabled ? 'on' : 'paused'} · auto-approve ${o.autoApprove ? 'ON' : 'off'} · classifier ${o.classifier} · range ${o.min}–${o.max}`,
        `session effort ${baseline ?? 'unknown'}${active ? ` · this turn ${active.level} (${active.by})` : ''}`,
        `turns by level: ${n(stats.turns)}`,
        `output tokens by level: ${n(stats.outputTokens)}`,
        `picks: ${stats.suggested} suggested, ${stats.accepted} applied, ${stats.declined} kept · Claude switches: ${stats.claudeSwitches}`,
        `saved: ${stats.bashCharsTrimmed} Bash chars (~${Math.round(stats.bashCharsTrimmed / 4)} tokens) · ${stats.readsGuarded} big reads bounced`,
      ].join('\n'),
    }
  })
}
