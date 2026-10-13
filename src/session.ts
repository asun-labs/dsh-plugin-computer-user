/**
 * dsh-plugin-computer-user / session.ts — the virtual desktop's shared state.
 *
 * One host-side `VirtualSession` is the single source of truth behind the
 * right-sidebar panel. It holds:
 *
 *   · the latest captured frame (a PNG on disk the panel fetches by url),
 *   · the viewport, in screen pixels, the frame was captured from,
 *   · every overlay the agent's actions produced — the pointer trail, click
 *     ripples, typed-text lines, plus the user's own coordinate hints,
 *   · the viewport instruction queue, which is where a user's click on the panel
 *     becomes a message the agent can pick up.
 *
 * The panel subscribes over SSE and renders; the tools mutate. Because state
 * lives here rather than in the tools, the panel shows the agent's work whether
 * the action landed on the real desktop (`link_mode: real`) or nowhere at all
 * (`link_mode: virtual`).
 *
 * @module dsh-plugin-computer-user/session
 */

/** Overlay kinds the panel knows how to draw. */
export type OverlayKind = 'cursor' | 'click' | 'type' | 'key' | 'hint' | 'agent-cursor'

/** One thing to draw on top of the snapshot, positioned in screen pixels. */
export interface Overlay {
  readonly id: number
  readonly kind: OverlayKind
  readonly x: number
  readonly y: number
  readonly at: number
  /** Short text for labels: key chord, typed text, or the hint's body. */
  readonly text?: string
  /** Click action, so a right-click can be drawn differently from a left one. */
  readonly action?: string
}

/** The captured frame currently on display. */
export interface Frame {
  /** Path on disk, served to the panel through the plugin's `frame` route. */
  readonly path: string
  /** Captured PNG size in pixels. */
  readonly width: number
  readonly height: number
  /** Virtual-screen origin, which a `region` crop advances. */
  readonly virtualOffset: readonly [number, number]
  /** Downscale applied at capture time; screen deltas multiply by this. */
  readonly scale: number
  /** Virtual-screen size at capture time, in screen pixels. */
  readonly viewport: { readonly width: number; readonly height: number }
  /** When the capture ran, in epoch milliseconds. */
  readonly at: number
  /** Set when this frame is a `region` crop, which the panel shows as a badge. */
  readonly region?: readonly [number, number, number, number]
}

/** A coordinate the user pointed at on the panel, waiting to be consumed by the agent. */
export interface Instruction {
  readonly id: number
  /** The screen coordinate the user clicked. */
  readonly x: number
  readonly y: number
  /** Optional note the user typed alongside the click. */
  readonly text?: string
  readonly at: number
}

/** Events pushed to the panel over SSE. */
export type SessionEvent =
  | { readonly type: 'overlay'; readonly overlay: Overlay; readonly cursor: { readonly x: number; readonly y: number } }
  | { readonly type: 'clear'; readonly scope: 'overlays' | 'all' }
  | { readonly type: 'instruction'; readonly instruction: Instruction }

/** One SSE frame: the id the panel acknowledges with `last-event-id`, and its payload. */
export interface SessionFrame {
  readonly id: number
  readonly event: SessionEvent
}

/** How many overlays are retained before the oldest are dropped. */
const OVERLAY_LIMIT = 240

/** The snapshot the panel renders. Deliberately JSON-shaped and stable. */
export interface SessionSnapshot {
  /** Monotonic revision, so the panel can skip identical renders. */
  readonly revision: number
  readonly frame: Frame | null
  /** Where the virtual pointer currently is, in screen pixels. */
  readonly cursor: { readonly x: number; readonly y: number }
  readonly overlays: readonly Overlay[]
  readonly instructions: readonly Instruction[]
  /** Real-desktop cursor, when a `real`-mode action reported one. */
  readonly realCursor: { readonly x: number; readonly y: number } | null
}

/**
 * The mutable state behind the panel.
 *
 * Not an EventEmitter: subscribers are called synchronously on every mutation
 * and the SSE route decides what to send each one. Keeping the fan-out out of
 * here means the session has no opinion about transports.
 */
export class VirtualSession {
  private frameValue: Frame | null = null
  private cursorValue = { x: 0, y: 0 }
  private realCursorValue: { x: number; y: number } | null = null
  private overlays: Overlay[] = []
  private instructions: Instruction[] = []
  private revisionValue = 0
  private eventId = 0
  private nextId = 1
  private readonly subscribers = new Set<(frame: SessionFrame | null, reason: string) => void>()

  /** The current snapshot; a new object whenever anything changed. */
  snapshot(): SessionSnapshot {
    return {
      revision: this.revisionValue,
      frame: this.frameValue,
      cursor: this.cursorValue,
      overlays: this.overlays,
      instructions: this.instructions,
      realCursor: this.realCursorValue,
    }
  }

  /** The frame on display, or `null` before the first capture. */
  get frame(): Frame | null {
    return this.frameValue
  }

  /** Where the virtual pointer is, in screen pixels. */
  get cursor(): { x: number; y: number } {
    return this.cursorValue
  }

  /**
   * Observe mutations.
   * @param listener - called with an incremental frame to publish (or `null`
   *   when the change is snapshot-only) and a reason for logging.
   * @returns an unsubscribe callback.
   */
  subscribe(listener: (frame: SessionFrame | null, reason: string) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * Replay every overlay recorded after an event id, for a panel that just connected.
   * @param after - the client's `last-event-id`, or `0` for everything retained.
   * @returns frames in order.
   */
  replay(after: number): SessionFrame[] {
    return this.overlays
      .filter((overlay) => overlay.id > after)
      .map((overlay) => ({ id: overlay.id, event: { type: 'overlay', overlay, cursor: this.cursorValue } as const }))
  }

  /** Install a freshly captured frame, keeping or resetting the overlays depending on geometry. */
  setFrame(frame: Frame, options: { readonly keepOverlays?: boolean } = {}): void {
    const previous = this.frameValue
    this.frameValue = frame
    // A new capture may have different geometry (a region crop, or the user
    // unplugged a monitor). Overlays recorded against the old geometry would
    // sit in the wrong place, so they are dropped unless the caller knows the
    // geometry is unchanged.
    const geometryChanged = !previous
      || previous.scale !== frame.scale
      || previous.virtualOffset[0] !== frame.virtualOffset[0]
      || previous.virtualOffset[1] !== frame.virtualOffset[1]
      || previous.width !== frame.width
      || previous.height !== frame.height
    if (geometryChanged && !options.keepOverlays) this.overlays = []
    this.bump('frame')
  }

  /** Point the virtual cursor, and record a trail entry so movement is visible. */
  moveCursor(x: number, y: number, options: { readonly trail?: boolean } = {}): void {
    this.cursorValue = { x, y }
    if (options.trail !== false) this.push({ kind: 'agent-cursor', x, y })
    else this.bump('cursor')
  }

  /** Record a click ripple at a screen coordinate. */
  click(x: number, y: number, action: string): void {
    this.cursorValue = { x, y }
    this.push({ kind: 'click', x, y, action })
  }

  /** Record typed text, anchored at the current cursor. */
  typed(text: string): void {
    this.push({ kind: 'type', x: this.cursorValue.x, y: this.cursorValue.y, text: truncate(text, 120) })
  }

  /** Record a key chord, anchored at the current cursor. */
  keypress(keys: readonly string[]): void {
    this.push({ kind: 'key', x: this.cursorValue.x, y: this.cursorValue.y, text: keys.join('+') })
  }

  /** Record that a real-desktop action reported the genuine cursor position. */
  setRealCursor(x: number, y: number): void {
    this.realCursorValue = { x, y }
    this.bump('real-cursor')
  }

  /**
   * Take a click the user made on the panel and queue it as guidance.
   *
   * The coordinate is the screen pixel the click maps to, which is exactly the
   * form the agent's own tools take — so an instruction needs no translation on
   * the way out.
   * @param x - screen x, already converted from panel pixels.
   * @param y - screen y, already converted from panel pixels.
   * @param text - an optional note typed by the user.
   * @returns the queued instruction.
   */
  hint(x: number, y: number, text?: string): Instruction {
    const at = Date.now()
    const instruction: Instruction = text === undefined
      ? { id: this.nextId++, x, y, at }
      : { id: this.nextId++, x, y, text, at }
    this.instructions = [...this.instructions.slice(-49), instruction]
    // The pin and the queue entry are one user action, so they are published as
    // two events off a single revision — not as a bare bump plus an event, which
    // would make the panel re-read the snapshot for nothing.
    this.appendOverlay({ kind: 'hint', x, y, at, ...(text ? { text } : {}) })
    this.revisionValue += 1
    this.publish({ type: 'instruction', instruction })
    return instruction
  }

  /** Drop overlays, and optionally the instruction queue too. */
  clear(scope: 'overlays' | 'all' = 'overlays'): void {
    if (scope === 'all') this.instructions = []
    this.overlays = []
    this.revisionValue += 1
    this.publish({ type: 'clear', scope })
  }

  /** Remove one queued instruction, for a user who changed their mind. */
  dropInstruction(id: number): boolean {
    const next = this.instructions.filter((instruction) => instruction.id !== id)
    if (next.length === this.instructions.length) return false
    this.instructions = next
    this.bump('instruction-dropped')
    return true
  }

  /**
   * The instructions the agent has not consumed yet, oldest first.
   *
   * Reading does not consume: the agent decides what to act on, and clears them
   * when it is done. That keeps a hint from vanishing because a read happened
   * to race a redraw.
   */
  pendingInstructions(): readonly Instruction[] {
    return this.instructions
  }

  /** Append one overlay and hand back the id it was assigned. */
  private appendOverlay(overlay: Omit<Overlay, 'id' | 'at'> & { readonly at?: number }): Overlay {
    const stored: Overlay = { ...overlay, id: this.eventId + 1, at: overlay.at ?? Date.now() }
    this.overlays = [...this.overlays, stored]
    this.trim()
    this.eventId += 1
    return stored
  }

  /** Append an overlay and publish it, in one revision. */
  private push(overlay: Omit<Overlay, 'id' | 'at'> & { readonly at?: number }): void {
    const stored = this.appendOverlay(overlay)
    this.revisionValue += 1
    this.publish({ type: 'overlay', overlay: stored, cursor: this.cursorValue })
  }

  private trim(): void {
    if (this.overlays.length > OVERLAY_LIMIT) {
      this.overlays = this.overlays.slice(-OVERLAY_LIMIT)
    }
  }

  /** Bump the revision with no event of its own: the panel re-reads the snapshot. */
  private bump(reason: string): void {
    this.revisionValue += 1
    for (const subscriber of this.subscribers) subscriber(null, reason)
  }

  private publish(event: SessionEvent): void {
    const frame: SessionFrame = { id: this.eventId, event }
    for (const subscriber of this.subscribers) subscriber(frame, event.type)
  }
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
