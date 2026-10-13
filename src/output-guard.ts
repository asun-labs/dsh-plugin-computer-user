/**
 * dsh-plugin-computer-user / output-guard.ts — LLM output filter.
 *
 * Ported from upstream. Sits on the provider `stream()` exit and looks at
 * assistant TEXT: if the model writes pseudo tool-call markup as conversation
 * (typing `computer_click({...})` instead of calling the tool), the first
 * occurrence is stripped and replaced with a coaching note; the second
 * occurrence of the same fingerprint passes, so a model that genuinely means to
 * emit that text cannot loop forever.
 *
 * Kept because a text-only model that has just been handed a computer-use tool
 * set is exactly the model most likely to narrate calls instead of making them.
 *
 * @module dsh-plugin-computer-user/output-guard
 */

import { createHash } from 'node:crypto'

/** Patterns for "a tool call written as conversation text". */
const FAKE_CALL_PATTERNS: readonly RegExp[] = [
  /<\s*(?:invoke|use|使用|tool)[^>]*>/i,
  /computer_[a-z_]+\s*\(\s*\{[^}]*\}\s*\)/i,
  /(?:\bawait\s+)?computer_[a-z_]+\(/,
  /<\s*\/\s*(?:invoke|use|tool)[^>]*>/i,
]

/** What the guard decided about one delta. */
export type GuardDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'reject'; readonly note: string; readonly fingerprint: string; readonly occurrence: number }
  | { readonly kind: 'pass-second'; readonly fingerprint: string; readonly occurrence: number }

/** A stateful guard over one stream. */
export interface OutputGuard {
  sniff(delta: string): GuardDecision
}

function fingerprintOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 24)
}

/**
 * Find a fake tool call in a text window.
 * @param text - the buffered text.
 * @returns the matched fingerprint, or `null`.
 */
export function detectFakeToolText(text: string): string | null {
  if (!text) return null
  for (const pattern of FAKE_CALL_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return fingerprintOf(match[0])
  }
  return null
}

/**
 * Create a guard.
 *
 * The buffer keeps only a tail window, because the text that matters is the
 * call being written right now, not the whole turn.
 * @param options - window size, the occurrence that is allowed through, and the note text.
 * @returns the guard.
 */
export function createOutputGuard(options: { bufferWindow?: number; allowAfter?: number; note?: string } = {}): OutputGuard {
  const bufferWindow = options.bufferWindow ?? 4000
  const allowAfter = options.allowAfter ?? 2
  const note = options.note ?? (
    '（输出已过滤：检测到把工具调用写成了对话文本。若确实要调用工具，请改为真正的工具调用；'
    + '若确实要原样输出这段文本，请再输出一次，第二次将放行不拦截。）'
  )
  let buffer = ''
  const counts = new Map<string, number>()

  return {
    sniff(delta: string): GuardDecision {
      buffer = (buffer + delta).slice(-bufferWindow)
      const fingerprint = detectFakeToolText(buffer)
      if (!fingerprint) return { kind: 'pass' }
      const occurrence = (counts.get(fingerprint) ?? 0) + 1
      counts.set(fingerprint, occurrence)
      // Consume the buffer so the same hit is not detected twice.
      buffer = ''
      if (occurrence >= allowAfter) return { kind: 'pass-second', fingerprint, occurrence }
      return { kind: 'reject', note, fingerprint, occurrence }
    },
  }
}
