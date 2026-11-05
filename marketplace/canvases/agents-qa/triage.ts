import { createCanvasHooks, getCanvasClient } from '@rwoll/canvas-kit/react'
import type canvas from './canvas.ts'
import type { FindingView, QaState } from './canvas.ts'
import type { Outcome } from './format.ts'

export const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()
export const client = getCanvasClient<typeof canvas>()

export type Tab = 'triage' | 'ready' | 'active' | 'done' | 'suppressed' | 'fixed' | 'all'

export const TABS: { id: Tab; label: string }[] = [
  { id: 'triage', label: 'To triage' },
  { id: 'ready', label: 'Ready to send' },
  { id: 'active', label: 'In progress' },
  { id: 'done', label: 'Done' },
  { id: 'fixed', label: 'Fixed' },
  { id: 'suppressed', label: 'Suppressed' },
  { id: 'all', label: 'All' },
]

const AGENT: readonly Outcome[] = ['fix', 'issue', 'investigate']

export function tabOf(finding: FindingView): Exclude<Tab, 'all'> {
  const item = finding.item
  if (!item?.decision) return finding.status === 'fixed' ? 'fixed' : 'triage'
  if (item.decision === 'suppress') return 'suppressed'
  if (item.state === 'sent' || item.state === 'working' || item.state === 'failed') return 'active'
  if (AGENT.includes(item.decision) && item.state === 'draft') return 'ready'
  return 'done'
}

export const inTab = (finding: FindingView, tab: Tab) => tab === 'all' || tabOf(finding) === tab

export const DECISIONS: { id: Outcome; label: string; key: string; hint: string }[] = [
  { id: 'fix', label: 'Fix', key: 'f', hint: 'A session fixes it and opens a draft PR with before and after screenshots' },
  { id: 'issue', label: 'File issue', key: 'i', hint: 'File a minimal bug, assigned to the owner, with the bug label' },
  { id: 'investigate', label: 'Investigate', key: 'v', hint: 'A session finds the root cause and whether it is a regression, without changing code' },
  { id: 'tracked', label: 'Tracked', key: 't', hint: 'An existing issue already covers it' },
  { id: 'suppress', label: 'Suppress', key: 's', hint: "Not a bug, or not worth fixing. Later runs don't report it again" },
]

export const DECISION_LABEL: Record<Outcome, string> = { fix: 'Fix', issue: 'File issue', investigate: 'Investigate', tracked: 'Tracked', suppress: 'Suppressed' }

export const SEVERITY_LABEL: Record<FindingView['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low', polish: 'Polish' }

export const STATUS_LABEL: Record<FindingView['status'], string> = { new: 'New', 'still-reproduces': 'Still reproduces', fixed: 'Fixed' }

/** What the decision is doing now, in a few words. */
export function progressLabel(finding: FindingView): string | null {
  const item = finding.item
  if (!item?.decision) return null
  if (item.decision === 'tracked' || item.decision === 'suppress') return DECISION_LABEL[item.decision]
  const verb = DECISION_LABEL[item.decision]
  switch (item.state) {
    case 'draft':
      return `${verb} · not sent`
    case 'sent':
      return `${verb} · sent`
    case 'working':
      return `${verb} · working`
    case 'failed':
      return `${verb} · failed`
    case 'done':
      return `${verb} · done`
  }
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const minutes = Math.round(Math.max(0, now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function when(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const shortCommit = (commit: string) => commit.slice(0, 8)

export function buildLabel(state: QaState['runs'][number]): string {
  const { version, commit } = state.build
  return [version, commit && shortCommit(commit)].filter(Boolean).join(' · ')
}
