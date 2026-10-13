/**
 * session.spec.ts — the board the sidebar renders.
 *
 * The panel is only as trustworthy as this object: an overlay that outlives a
 * geometry change, or a hint that vanishes on read, would make the picture
 * disagree with reality. Those two cases get the most attention here.
 */

import { describe, expect, it, vi } from 'vitest'
import { VirtualSession, type Frame, type SessionFrame } from '../src/session.ts'

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    path: '/tmp/shot.png',
    width: 1920,
    height: 1080,
    virtualOffset: [0, 0],
    scale: 1,
    viewport: { width: 1920, height: 1080 },
    at: 1_000,
    ...overrides,
  }
}

describe('VirtualSession', () => {
  it('starts empty, with no frame and a zero cursor', () => {
    const session = new VirtualSession()
    const snapshot = session.snapshot()
    expect(snapshot.frame).toBeNull()
    expect(snapshot.overlays).toEqual([])
    expect(snapshot.cursor).toEqual({ x: 0, y: 0 })
    expect(session.frame).toBeNull()
  })

  it('bumps the revision on every mutation, so the panel can skip identical renders', () => {
    const session = new VirtualSession()
    const before = session.snapshot().revision
    session.setFrame(frame())
    session.moveCursor(10, 20)
    expect(session.snapshot().revision).toBeGreaterThan(before + 1)
  })

  it('drops overlays when the capture geometry changes', () => {
    const session = new VirtualSession()
    session.setFrame(frame())
    session.click(100, 100, 'click')
    expect(session.snapshot().overlays.length).toBeGreaterThan(0)
    // A region crop changes the frame's size and origin, so old marks are wrong.
    session.setFrame(frame({ width: 960, height: 540, virtualOffset: [960, 540] }))
    expect(session.snapshot().overlays).toEqual([])
  })

  it('keeps overlays when the geometry is unchanged and the caller asks', () => {
    const session = new VirtualSession()
    session.setFrame(frame())
    session.click(100, 100, 'click')
    const kept = session.snapshot().overlays.length
    session.setFrame(frame({ at: 2_000 }), { keepOverlays: true })
    expect(session.snapshot().overlays.length).toBe(kept)
  })

  it('moves the cursor and records a trail point by default', () => {
    const session = new VirtualSession()
    session.moveCursor(300, 400)
    expect(session.cursor).toEqual({ x: 300, y: 400 })
    expect(session.snapshot().overlays.at(-1)).toMatchObject({ kind: 'agent-cursor', x: 300, y: 400 })
  })

  it('can move the cursor without a trail point', () => {
    const session = new VirtualSession()
    session.moveCursor(300, 400, { trail: false })
    expect(session.cursor).toEqual({ x: 300, y: 400 })
    expect(session.snapshot().overlays).toEqual([])
  })

  it('records a click at the clicked coordinate with its action', () => {
    const session = new VirtualSession()
    session.click(50, 60, 'right_click')
    const overlay = session.snapshot().overlays.at(-1)
    expect(overlay).toMatchObject({ kind: 'click', x: 50, y: 60, action: 'right_click' })
    expect(session.cursor).toEqual({ x: 50, y: 60 })
  })

  it('anchors typed text and key chords at the current cursor', () => {
    const session = new VirtualSession()
    session.moveCursor(11, 22, { trail: false })
    session.typed('hello 世界')
    session.keypress(['ctrl', 'c'])
    const overlays = session.snapshot().overlays
    expect(overlays.at(-2)).toMatchObject({ kind: 'type', x: 11, y: 22, text: 'hello 世界' })
    expect(overlays.at(-1)).toMatchObject({ kind: 'key', x: 11, y: 22, text: 'ctrl+c' })
  })

  it('flattens whitespace in typed text so a label cannot break the layout', () => {
    const session = new VirtualSession()
    session.typed('line one\nline two')
    expect(session.snapshot().overlays.at(-1)?.text).toBe('line one line two')
  })

  it('truncates very long typed text', () => {
    const session = new VirtualSession()
    session.typed('x'.repeat(400))
    const text = session.snapshot().overlays.at(-1)?.text ?? ''
    expect(text.length).toBeLessThanOrEqual(121)
    expect(text.endsWith('…')).toBe(true)
  })

  it('queues a user hint without consuming it on read', () => {
    const session = new VirtualSession()
    const instruction = session.hint(800, 450, '点这里')
    expect(instruction).toMatchObject({ x: 800, y: 450, text: '点这里' })
    // Reading twice must not empty it — the agent decides when it is done.
    expect(session.pendingInstructions()).toHaveLength(1)
    expect(session.pendingInstructions()).toHaveLength(1)
  })

  it('records a hint overlay alongside the queued instruction', () => {
    const session = new VirtualSession()
    session.hint(800, 450)
    const hint = session.snapshot().overlays.find(overlay => overlay.kind === 'hint')
    expect(hint).toMatchObject({ kind: 'hint', x: 800, y: 450 })
  })

  it('removes one instruction by id', () => {
    const session = new VirtualSession()
    const first = session.hint(1, 1)
    session.hint(2, 2)
    expect(session.dropInstruction(first.id)).toBe(true)
    expect(session.pendingInstructions().map(entry => entry.x)).toEqual([2])
    expect(session.dropInstruction(9999)).toBe(false)
  })

  it('clears overlays only, then everything', () => {
    const session = new VirtualSession()
    session.hint(5, 5)
    session.click(9, 9, 'click')
    session.clear('overlays')
    expect(session.snapshot().overlays).toEqual([])
    expect(session.snapshot().instructions).toHaveLength(1)
    session.clear('all')
    expect(session.snapshot().instructions).toEqual([])
  })

  it('caps the instruction queue and keeps the newest', () => {
    const session = new VirtualSession()
    for (let index = 0; index < 60; index += 1) session.hint(index, index)
    const pending = session.pendingInstructions()
    expect(pending.length).toBeLessThanOrEqual(50)
    expect(pending.at(-1)?.x).toBe(59)
  })

  it('publishes incremental frames to subscribers and null for snapshot-only changes', () => {
    const session = new VirtualSession()
    const seen: Array<{ frame: SessionFrame | null; reason: string }> = []
    session.subscribe((frameValue, reason) => seen.push({ frame: frameValue, reason }))
    session.setFrame(frame())
    session.click(1, 2, 'click')
    session.hint(3, 4)
    // A frame install is a snapshot-only ping; a click and a hint each publish
    // exactly one incremental event rather than bumping and publishing both.
    expect(seen.map(entry => entry.reason)).toEqual(['frame', 'overlay', 'instruction'])
    expect(seen[0]?.frame).toBeNull()
    expect(seen[1]?.frame?.event.type).toBe('overlay')
    expect(seen[2]?.frame?.event.type).toBe('instruction')
    // The hint's pin rides the same revision as its instruction event.
    expect(session.replay(0).some(entry => entry.event.type === 'overlay' && entry.event.overlay.kind === 'hint')).toBe(true)
  })

  it('stops notifying after unsubscribe', () => {
    const session = new VirtualSession()
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)
    session.click(1, 1, 'click')
    const calls = listener.mock.calls.length
    unsubscribe()
    session.click(2, 2, 'click')
    expect(listener.mock.calls.length).toBe(calls)
  })

  it('replays only the overlays a reconnecting panel has not seen', () => {
    const session = new VirtualSession()
    session.click(1, 1, 'click')
    const first = session.snapshot().overlays.at(-1)?.id ?? 0
    session.click(2, 2, 'click')
    const all = session.replay(0)
    const recent = session.replay(first)
    expect(all.length).toBeGreaterThan(recent.length)
    expect(recent.every(entry => entry.id > first)).toBe(true)
  })

  it('reports the real cursor separately from the virtual one', () => {
    const session = new VirtualSession()
    session.moveCursor(10, 10, { trail: false })
    session.setRealCursor(11, 12)
    const snapshot = session.snapshot()
    expect(snapshot.cursor).toEqual({ x: 10, y: 10 })
    expect(snapshot.realCursor).toEqual({ x: 11, y: 12 })
  })
})
