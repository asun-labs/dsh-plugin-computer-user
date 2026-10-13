/**
 * geometry.spec.ts — the coordinate math the whole visualization rests on.
 *
 * If a round-trip through these helpers ever stops being exact, a click the user
 * makes on the panel stops matching the coordinate the agent acts on, which is
 * the one bug that would make the panel actively misleading rather than merely
 * unhelpful. Hence the round-trip tests first.
 */

import { describe, expect, it } from 'vitest'
import {
  fitScale,
  frameToScreen,
  originFor,
  panelToScreen,
  screenToFrame,
  screenToPanel,
  type FrameMetrics,
  type Size,
} from '../src/geometry.ts'

/** A plain 1920×1080 screen captured at full size. */
const FULL: FrameMetrics = { width: 1920, height: 1080, virtualOffset: [0, 0], scale: 1 }

/** The same screen, downscaled to 0.5 — which is what upstream's default produces. */
const HALF: FrameMetrics = { width: 960, height: 540, virtualOffset: [0, 0], scale: 0.5 }

/** A second monitor to the left of the primary one, so the origin is negative. */
const LEFT_MONITOR: FrameMetrics = { width: 3840, height: 1080, virtualOffset: [-1920, 0], scale: 0.5 }

/** A cropped capture: the bottom-right quarter of the 1920×1080 screen. */
const CROPPED: FrameMetrics = { width: 960, height: 540, virtualOffset: [960, 540], scale: 1 }

describe('screenToFrame / frameToScreen', () => {
  it('is the identity at 1:1 with no offset', () => {
    expect(screenToFrame({ x: 300, y: 200 }, FULL)).toEqual({ x: 300, y: 200 })
  })

  it('applies scale when converting screen pixels to frame pixels', () => {
    expect(screenToFrame({ x: 300, y: 200 }, HALF)).toEqual({ x: 150, y: 100 })
  })

  it('subtracts the virtual-screen origin, including a negative one', () => {
    expect(screenToFrame({ x: -1920, y: 0 }, LEFT_MONITOR)).toEqual({ x: 0, y: 0 })
    expect(screenToFrame({ x: -1000, y: 400 }, LEFT_MONITOR)).toEqual({ x: 460, y: 200 })
  })

  it('honours the origin a crop advances', () => {
    expect(screenToFrame({ x: 960, y: 540 }, CROPPED)).toEqual({ x: 0, y: 0 })
  })

  it('round-trips exactly for every geometry', () => {
    for (const metrics of [FULL, HALF, LEFT_MONITOR, CROPPED]) {
      for (const point of [{ x: 0, y: 0 }, { x: 123, y: 456 }, { x: 1919, y: 1079 }]) {
        const back = frameToScreen(screenToFrame(point, metrics), metrics)
        expect(back.x).toBeCloseTo(point.x, 9)
        expect(back.y).toBeCloseTo(point.y, 9)
      }
    }
  })
})

describe('fitScale', () => {
  it('shrinks to the constraining axis', () => {
    // A 16:9 frame in a tall pane is limited by width.
    expect(fitScale({ width: 1920, height: 1080 }, { width: 480, height: 900 })).toBeCloseTo(0.25, 9)
  })

  it('is limited by height in a wide pane', () => {
    expect(fitScale({ width: 1920, height: 1080 }, { width: 4000, height: 540 })).toBeCloseTo(0.5, 9)
  })

  it('never stretches past 1:1 when the pane is larger than the frame', () => {
    // Deliberately allowed to exceed 1 — `zoomFactor` is what caps enlargement,
    // and the panel needs the plain ratio to compute a 1:1 zoom later.
    expect(fitScale({ width: 800, height: 600 }, { width: 1600, height: 1200 })).toBeCloseTo(2, 9)
  })

  it('preserves the aspect ratio, which is what keeps the snapshot unstretched', () => {
    const frame: Size = { width: 1920, height: 1080 }
    const viewport: Size = { width: 700, height: 500 }
    const scale = fitScale(frame, viewport)
    expect(frame.width * scale).toBeLessThanOrEqual(viewport.width + 1e-9)
    expect(frame.height * scale).toBeLessThanOrEqual(viewport.height + 1e-9)
  })

  it('accounts for the inset on both edges', () => {
    expect(fitScale({ width: 1000, height: 1000 }, { width: 1000, height: 1000 }, 50)).toBeCloseTo(0.9, 9)
  })

  it('falls back to 1 before geometry is measurable', () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 400, height: 400 })).toBe(1)
    expect(fitScale({ width: 800, height: 600 }, { width: 0, height: 0 })).toBe(1)
  })
})

describe('originFor', () => {
  it('centres content smaller than the viewport, ignoring pan', () => {
    const origin = originFor({ x: 999, y: -999 }, { width: 400, height: 300 }, { width: 1000, height: 700 })
    expect(origin).toEqual({ x: 300, y: 200 })
  })

  it('lets oversized content reach either edge but not pass it', () => {
    const content = { width: 2000, height: 1500 }
    const viewport = { width: 1000, height: 700 }
    // Centred is 0-(2000-1000)/2 = -500 on x.
    expect(originFor({ x: 0, y: 0 }, content, viewport)).toEqual({ x: -500, y: -400 })
    // Dragging far right clamps at the top-left edge.
    expect(originFor({ x: 9999, y: 9999 }, content, viewport)).toEqual({ x: 0, y: 0 })
    // Dragging far left clamps at the bottom-right edge.
    expect(originFor({ x: -9999, y: -9999 }, content, viewport)).toEqual({ x: -1000, y: -800 })
  })

  it('allows a small pan in either direction while inside the bounds', () => {
    const content = { width: 2000, height: 1500 }
    const viewport = { width: 1000, height: 700 }
    expect(originFor({ x: 100, y: -50 }, content, viewport)).toEqual({ x: -400, y: -450 })
  })
})

describe('panelToScreen / screenToPanel', () => {
  const viewport: Size = { width: 1000, height: 700 }
  const display: Size = { width: 960, height: 540 }
  const origin = originFor({ x: 0, y: 0 }, display, viewport)

  it('maps the content top-left to the frame or the screen origin', () => {
    expect(panelToScreen(origin, origin, display, FULL)).toEqual({ x: 0, y: 0 })
  })

  it('maps the content bottom-right to the far corner', () => {
    const corner = panelToScreen({ x: origin.x + display.width, y: origin.y + display.height }, origin, display, FULL)
    expect(corner.x).toBeCloseTo(1920, 6)
    expect(corner.y).toBeCloseTo(1080, 6)
  })

  it('round-trips a screen point through panel space', () => {
    for (const metrics of [FULL, HALF, CROPPED]) {
      for (const point of [{ x: 100, y: 200 }, { x: 1500, y: 900 }]) {
        const panel = screenToPanel(point, origin, display, metrics)
        const back = panelToScreen(panel, origin, display, metrics)
        expect(back.x).toBeCloseTo(point.x, 6)
        expect(back.y).toBeCloseTo(point.y, 6)
      }
    }
  })

  it('is unaffected by the original capture scale, because both directions agree', () => {
    // The same screen point must convert consistently whether the PNG was
    // captured at full size or downscaled; the panel just displays it smaller.
    const panelFull = screenToPanel({ x: 400, y: 300 }, origin, display, FULL)
    const panelHalf = screenToPanel({ x: 400, y: 300 }, origin, display, HALF)
    expect(panelFull.x).toBeCloseTo(panelHalf.x, 6)
    expect(panelFull.y).toBeCloseTo(panelHalf.y, 6)
  })

  it('returns an origin-relative result for degenerate display sizes', () => {
    expect(panelToScreen({ x: 10, y: 10 }, { x: 0, y: 0 }, { width: 0, height: 0 }, FULL)).toEqual({ x: 0, y: 0 })
  })
})
