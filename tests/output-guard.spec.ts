/**
 * output-guard.spec.ts — the prose-instead-of-a-tool-call filter.
 *
 * Ported behaviour, but the "second chance" rule is the load-bearing part: a
 * guard that never lets the text through would trap a model that genuinely means
 * to print it.
 */

import { describe, expect, it } from 'vitest'
import { createOutputGuard, detectFakeToolText } from '../src/output-guard.ts'

describe('detectFakeToolText', () => {
  it('catches a tool call written as a call expression', () => {
    expect(detectFakeToolText('sure: computer_click({ coordinate: [1,2] })')).not.toBeNull()
  })

  it('catches an await-ed call', () => {
    expect(detectFakeToolText('let me await computer_screenshot()')).not.toBeNull()
  })

  it('catches pseudo-XML invoke markup', () => {
    expect(detectFakeToolText('<invoke name="computer_click">')).not.toBeNull()
    expect(detectFakeToolText('</invoke>')).not.toBeNull()
    expect(detectFakeToolText('<使用工具：computer_click>')).not.toBeNull()
  })

  it('leaves ordinary prose alone', () => {
    expect(detectFakeToolText('I will take a screenshot and then click the button.')).toBeNull()
    expect(detectFakeToolText('')).toBeNull()
  })

  it('returns the same fingerprint for the same offending snippet', () => {
    const first = detectFakeToolText('computer_click({ coordinate: [1,2] })')
    const second = detectFakeToolText('computer_click({ coordinate: [1,2] })')
    expect(first).toBe(second)
  })
})

describe('createOutputGuard', () => {
  it('passes clean text straight through', () => {
    const guard = createOutputGuard()
    expect(guard.sniff('The window is 1920 by 1080.')).toEqual({ kind: 'pass' })
  })

  it('rejects the first occurrence and hands back a note', () => {
    const guard = createOutputGuard({ note: 'NOTE' })
    const decision = guard.sniff('computer_click({ coordinate: [1,2] })')
    expect(decision.kind).toBe('reject')
    expect(decision).toMatchObject({ note: 'NOTE', occurrence: 1 })
  })

  it('lets the second identical attempt through, so a model cannot be trapped', () => {
    const guard = createOutputGuard({ allowAfter: 2 })
    expect(guard.sniff('computer_click({ coordinate: [1,2] })').kind).toBe('reject')
    expect(guard.sniff('computer_click({ coordinate: [1,2] })').kind).toBe('pass-second')
  })

  it('counts each distinct snippet separately', () => {
    const guard = createOutputGuard({ allowAfter: 2 })
    expect(guard.sniff('computer_click({ coordinate: [1,2] })').kind).toBe('reject')
    expect(guard.sniff('computer_screenshot({ path: "a.png" })').kind).toBe('reject')
    expect(guard.sniff('computer_click({ coordinate: [1,2] })').kind).toBe('pass-second')
  })

  it('detects a call split across deltas', () => {
    const guard = createOutputGuard()
    expect(guard.sniff('let me call computer_cli').kind).toBe('pass')
    expect(guard.sniff('ck({ coordinate: [1,2] })').kind).toBe('reject')
  })

  it('keeps only a tail window of text', () => {
    const snippet = 'computer_click({ coordinate: [1,2] })'
    // A window wide enough for the snippet still catches it, and the filler
    // before it is irrelevant.
    const wide = createOutputGuard({ bufferWindow: 64 })
    expect(wide.sniff('x'.repeat(200)).kind).toBe('pass')
    expect(wide.sniff(snippet).kind).toBe('reject')

    // A window narrower than the snippet truncates its head, so the pattern is
    // genuinely gone rather than matched by luck — the guard trades a rare miss
    // for a bounded buffer.
    const narrow = createOutputGuard({ bufferWindow: 30 })
    expect(narrow.sniff(snippet).kind).toBe('pass')
  })
})
