/**
 * dsh-plugin-computer-user / geometry.ts — the panel's coordinate math.
 *
 * Three spaces are in play, and keeping them apart is what makes the virtual
 * pointer line up with the agent's clicks:
 *
 *   screen   — virtual-screen pixels, the agent's coordinate system. This is
 *              what `computer_*` tools take and what `virtual_offset` anchors.
 *   frame    — pixels inside the captured PNG, which is the screen shifted by
 *              `virtualOffset` and scaled by `scale` (capture.ps1 may crop by
 *              `region`, and the offset already accounts for the crop origin).
 *   panel    — pixels inside the sidebar viewport: the frame scaled by
 *              `zoom * fit` and shifted by `pan`.
 *
 * Pure functions only, so the whole transform is unit-testable without a DOM.
 *
 * @module dsh-plugin-computer-user/geometry
 */

/** A point or size in any of the three spaces. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** Dimensions of the captured PNG plus everything needed to invert the capture. */
export interface FrameMetrics {
  /** Captured PNG width, in frame pixels (after `region` crop and `scale`). */
  readonly width: number
  /** Captured PNG height, in frame pixels. */
  readonly height: number
  /** Virtual-screen origin, which `region` cropping advances. */
  readonly virtualOffset: readonly [number, number]
  /** Downscale capture.ps1 applied, so screen deltas multiply by this. */
  readonly scale: number
}

/** Viewport dimensions of the sidebar pane, in panel pixels. */
export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * Screen pixels → frame pixels.
 *
 * `region` cropping moves `virtualOffset` to the cropped origin, so subtracting
 * the offset is correct whether or not a region was captured.
 * @param point - a point in virtual-screen pixels.
 * @param metrics - the capture that point should be mapped into.
 * @returns the point in frame pixels.
 */
export function screenToFrame(point: Point, metrics: FrameMetrics): Point {
  return {
    x: (point.x - metrics.virtualOffset[0]) * metrics.scale,
    y: (point.y - metrics.virtualOffset[1]) * metrics.scale,
  }
}

/**
 * Frame pixels → screen pixels: the exact inverse of {@link screenToFrame}.
 * This is the direction a click on the panel travels, so a panel click and an
 * agent click naming the same pixel meet at the same screen coordinate.
 * @param point - a point in frame pixels.
 * @param metrics - the capture those frame pixels came from.
 * @returns the point in virtual-screen pixels.
 */
export function frameToScreen(point: Point, metrics: FrameMetrics): Point {
  return {
    x: point.x / metrics.scale + metrics.virtualOffset[0],
    y: point.y / metrics.scale + metrics.virtualOffset[1],
  }
}

/**
 * The scale that fits a frame inside a viewport without cropping it.
 *
 * Both axes are divided and the smaller wins, which is what preserves the 1:1
 * aspect ratio: a 16:9 frame in a square pane letterboxes rather than stretches.
 * @param frame - the frame's natural size.
 * @param viewport - the space available for it.
 * @param inset - pixels to keep clear on every edge.
 * @returns the fit scale, or `1` when either size is not yet measurable.
 */
export function fitScale(frame: Size, viewport: Size, inset = 0): number {
  const width = viewport.width - inset * 2
  const height = viewport.height - inset * 2
  if (frame.width <= 0 || frame.height <= 0 || width <= 0 || height <= 0) return 1
  return Math.min(width / frame.width, height / frame.height)
}

/**
 * Where the content sits inside the viewport, given a pan intent.
 *
 * `pan` is the offset *beyond* centred, and centring is the resting position —
 * so a snapshot that already fits (the 1:1 case) simply sits centred and cannot
 * be dragged around, while a zoomed-in one can be panned within its own bounds
 * and no further. Without the clamp, zooming in and dragging would slide the
 * image off into empty space with no way back.
 * @param pan - the requested pan beyond centred, in panel pixels.
 * @param content - the scaled content size.
 * @param viewport - the viewport size.
 * @returns the content's top-left corner inside the viewport.
 */
export function originFor(pan: Point, content: Size, viewport: Size): Point {
  const axis = (contentAxis: number, viewportAxis: number, panAxis: number): number => {
    const centred = (viewportAxis - contentAxis) / 2
    if (contentAxis <= viewportAxis) return centred
    return Math.min(0, Math.max(viewportAxis - contentAxis, centred + panAxis))
  }
  return {
    x: axis(content.width, viewport.width, pan.x),
    y: axis(content.height, viewport.height, pan.y),
  }
}

/**
 * Panel pixels → screen pixels, the transform the panel's own clicks travel.
 *
 * `display` is the frame's on-screen size (`frame * fit * zoom`) and `origin`
 * is the top-left of that content inside the viewport, so the whole mapping is
 * a scale and a translation.
 * @param point - a point in panel pixels, relative to the viewport.
 * @param origin - the content's top-left inside the viewport.
 * @param display - the content's on-screen size.
 * @param metrics - the metrics of the frame being displayed.
 * @returns the point in virtual-screen pixels, unrounded.
 */
export function panelToScreen(point: Point, origin: Point, display: Size, metrics: FrameMetrics): Point {
  if (display.width <= 0 || display.height <= 0) return { x: 0, y: 0 }
  const frame: Point = {
    x: ((point.x - origin.x) / display.width) * metrics.width,
    y: ((point.y - origin.y) / display.height) * metrics.height,
  }
  return frameToScreen(frame, metrics)
}

/**
 * Screen pixels → panel pixels: where an overlay element (cursor, ripple, hint
 * pin) must be drawn for a screen coordinate.
 * @param point - a point in virtual-screen pixels.
 * @param origin - the content's top-left inside the viewport.
 * @param display - the content's on-screen size.
 * @param metrics - the metrics of the frame being displayed.
 * @returns the point in panel pixels.
 */
export function screenToPanel(point: Point, origin: Point, display: Size, metrics: FrameMetrics): Point {
  const frame = screenToFrame(point, metrics)
  return {
    x: origin.x + (frame.x / metrics.width) * display.width,
    y: origin.y + (frame.y / metrics.height) * display.height,
  }
}
