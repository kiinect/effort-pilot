// Zero-token effort classifier: local rules only, no model call.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Level = (typeof LEVELS)[number]

export type Verdict = {
  level: Level
  /** 'sure' = strong signal or explicit ask; 'unsure' = close to the default. */
  confidence: 'sure' | 'unsure'
  reason: string
}

export const isLevel = (v: unknown): v is Level =>
  typeof v === 'string' && (LEVELS as readonly string[]).includes(v)

export const rank = (l: Level) => LEVELS.indexOf(l)

export const clampLevel = (l: Level, min: Level, max: Level): Level =>
  LEVELS[Math.min(Math.max(rank(l), rank(min)), rank(max))] as Level

// A follow-up inherits the difficulty of the work in flight: never retune it.
const CONTINUE =
  /^(y|ye[sp]|yeah|ok(ay)?|sure|go( ahead)?|do it|continue|proceed|keep going|next|sounds good|lgtm|try again|retry|again|same|thanks?( you)?|ty|cool|nice|perfect|great)\b[\s.!]*$/i

const EXPLICIT_MAX = /\b(ultrathink|max(imum)? effort|think (really |very )?hard(est)?)\b/i
const EXPLICIT_XHIGH = /\b(think harder|think deeply|deep[- ]?(dive|think)|be (very )?thorough|exhaustive(ly)?)\b/i
const EXPLICIT_LOW = /\b(low effort|don'?t (over)?think|no need to think)\b/i
const QUICK = /\b(quick(ly)?|real quick|just|simple|tiny|trivial|small)\b/i
const CAREFUL = /\b(carefully|thoroughly|rigorous(ly)?|edge cases?|high[- ]stakes|production)\b/i

const OPS_START =
  /^(please\s+)?(run|rerun|show|list|print|open|cat|ls|cd|start|stop|restart|kill|launch|install|uninstall|update|upgrade|commit|push|pull|merge|checkout|stash|rename|move|copy|delete|remove|format|lint|git\s+\w+|npm\s+\w+|cargo\s+\w+|make\b)/i
const QUESTION_START =
  /^(what('?s| is| are| does)?|where|which|when|who|how (many|much|do i)|is (it|there|this)|does|can you (tell|show)|tell me|summari[sz]e|tl;?dr|explain briefly)\b/i
const HARD =
  /\b(debug|root cause|why (is|does|do|did|isn'?t|doesn'?t|won'?t)|race( condition)?|deadlock|memory leak|leak|architect(ure)?|design|refactor|migrat(e|ion)|optimi[sz]e|performance|implement|from scratch|build (a|an|the|me)|plugin|algorithm|prove|proof|security|vulnerab|exploit|concurren|thread[- ]safe|reverse[- ]engineer|benchmark|investigate|figure out|diagnos)/gi
const TRACE = /```|Traceback \(most recent|\bat \S+:\d+:\d+|\bError:|\bpanicked at\b|segfault|stack trace|exit code [1-9]/i

export type ClassifyOptions = { min?: Level; max?: Level }

export function classify(raw: string, opts: ClassifyOptions = {}): Verdict | null {
  const text = raw.trim()
  if (!text) return null
  const min = opts.min ?? 'low'
  const max = opts.max ?? 'max'
  const done = (level: Level, confidence: Verdict['confidence'], reason: string): Verdict => ({
    level: clampLevel(level, min, max),
    confidence,
    reason,
  })

  if (CONTINUE.test(text)) return null
  if (EXPLICIT_MAX.test(text)) return done('max', 'sure', 'you asked for maximum thinking')
  if (EXPLICIT_LOW.test(text)) return done('low', 'sure', 'you asked for low effort')
  if (EXPLICIT_XHIGH.test(text)) return done('xhigh', 'sure', 'you asked for deep thinking')

  let score = 0
  const why: string[] = []
  const len = text.length
  if (len < 80) { score -= 1; why.push('short') }
  else if (len > 2000) { score += 2; why.push('long spec') }
  else if (len > 600) { score += 1; why.push('detailed ask') }

  if (OPS_START.test(text)) { score -= 2; why.push('routine command') }
  else if (QUESTION_START.test(text) && len < 300) { score -= 1; why.push('lookup question') }

  const hard = new Set((text.match(HARD) ?? []).map(w => w.toLowerCase().split(/\s/)[0]))
  if (hard.size) { score += Math.min(hard.size, 3); why.push(`hard: ${[...hard].slice(0, 3).join(', ')}`) }
  if (TRACE.test(text)) { score += 1; why.push('error/trace pasted') }

  const asks = text.split(/\n\s*[-*\d]+[.)]?\s+|[.?!]\s+(?=[A-Z])/).filter(s => s.trim().length > 12).length
  if (asks >= 6) { score += 1; why.push(`${asks} requirements`) }

  if (QUICK.test(text)) { score -= 1; why.push('"quick/simple"') }
  if (CAREFUL.test(text)) { score += 1; why.push('"careful"') }

  // Lowering is where the savings are; raising past high needs strong evidence.
  const level: Level =
    score <= -3 ? 'low' : score === -2 ? 'medium' : score >= 5 ? 'xhigh' : 'high'
  const confidence = score <= -3 || score >= 5 ? 'sure' : 'unsure'
  return done(level, confidence, why.join('; ') || 'typical task')
}

/** Parse a one-word model answer into a level, or null. */
export const parseLevel = (answer: string): Level | null => {
  const m = answer.toLowerCase().match(/\b(low|medium|high|xhigh|max)\b/)
  return m ? (m[1] as Level) : null
}

export function trimOutput(out: string, limit: number): { text: string; cut: number } | null {
  if (limit <= 0 || out.length <= limit) return null
  const head = Math.floor(limit * 0.4)
  const tail = limit - head
  // Cut on line boundaries so no line is half-shown.
  const headEnd = out.lastIndexOf('\n', head) > head * 0.5 ? out.lastIndexOf('\n', head) : head
  const tailStart0 = out.length - tail
  const nl = out.indexOf('\n', tailStart0)
  const tailStart = nl !== -1 && nl - tailStart0 < tail * 0.5 ? nl + 1 : tailStart0
  const cut = tailStart - headEnd
  return { text: `${out.slice(0, headEnd)}\n…[${cut} chars trimmed]…\n${out.slice(tailStart)}`, cut }
}
