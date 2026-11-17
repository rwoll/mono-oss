import type { SessionSummary } from './scan.ts'
import type { TaskType } from './shared.ts'

// The kind of task is not recorded, so it is worked out from what you asked for and what
// the session did. A request usually says what it is for at its start ("Fix…", "Add…",
// "Review…"), so the rule that matches earliest wins. You, or the agent, can correct a
// session; see TaskTypes in store.ts.

const RULES: readonly [TaskType, RegExp][] = [
  [
    'followup',
    /\b(review (comments?|feedback|threads?)|address (the |all |any |these |those )?(review|feedback|comments?)|pr (comments?|feedback)|(fix|failing|failed|broken|red) (the )?(ci|checks?|pipeline)|ci (is |was )?(failing|red|broken)|merge conflicts?|rebase|(update|finish|finish up|land|merge) (the |this |my )?(pr|pull request)|follow[- ]?ups?)\b/,
  ],
  ['review', /\b(code[- ]review|review (this|the|my|these|that|a) (pr|pull request|changes?|diff|code|branch|commit)|review pr|pr review|security review|audit)\b/],
  ['qa', /\b(qa|e2e|end[- ]to[- ]end|test (plan|pass|coverage)|(add|write|run|update|flaky|missing) (the |unit |browser |more |some )?tests?|smoke test|verify|repro(duce|duction)?|self[- ]?host)\b/],
  ['bugfix', /\b(fix(es|ed|ing)?|bugs?|broken|regress(ion|ed)|crash(es|ing)?|doesn'?t work|not working|debug)\b/],
  ['docs', /\b(docs?|documentation|readme|changelog|release notes|write[- ]?up|blog|announcement|draft|proofread|reword|summar(y|ize|ise)|email|slack message|pr description|slides?)\b/],
  ['chores', /\b(bump|upgrade|dependenc(y|ies)|rename|clean ?up|chore|reformat|lint|release|publish|housekeeping|tidy|remove (unused|dead|old)|cherry[- ]pick|backport)\b/],
  ['research', /\b(research|investigat(e|ion)|explor(e|ation)|compar(e|ison)|why|how (does|do|is|are|can|would|should)|find out|look into|understand|explain|trace|analy[sz]e|evaluate|brainstorm|prototype|experiment|spike|bake ?off)\b/],
  ['feature', /\b(add|implement|build|create|support|introduce|make|enable|allow|extend|improve|integrate|migrate|refactor|port|wire)\b/],
]
/** How much earlier the more specific kinds count: "address the review comments and fix…" is follow-up. */
const HEAD_START: Partial<Record<TaskType, number>> = { followup: 60, review: 30 }

/** The task type a session's request and work point to. */
export function classify(session: Pick<SessionSummary, 'title' | 'prompt' | 'tools' | 'filesChanged'>): TaskType {
  const request = `${session.title}\n${session.prompt}`.toLowerCase()
  let best: { type: TaskType; at: number } | undefined
  for (const [type, pattern] of RULES) {
    const match = pattern.exec(request)
    if (!match) continue
    const at = match.index - (HEAD_START[type] ?? 0)
    if (!best || at < best.at) best = { type, at }
  }
  if (best) return best.type
  // Nothing in the request says: a session that changed files built something, and one that only read looked into something.
  return session.filesChanged > 0 || (session.tools.edit?.calls ?? 0) > 0 ? 'feature' : 'research'
}
