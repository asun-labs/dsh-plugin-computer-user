/**
 * dsh-plugin-computer-user / client.tsx — the snapshot panel.
 *
 * The browser half registers three things:
 *
 *   · a right-sidebar tab kind, so the panel is a real dockable page rather
 *     than a floating drawer that fights the app's own layout;
 *   · the pane body, which is the visualization: the latest capture, the
 *     agent's virtual pointer and its click ripples drawn on top of it, and a
 *     place for you to click to tell the agent where to look;
 *   · a settings card, so `link_mode` has a one-click switch rather than
 *     living in a config file.
 *
 * Coordinates travel in screen pixels everywhere except inside this file, where
 * they are converted to panel pixels for drawing by the shared `geometry.ts`
 * helpers — the same functions the host uses, so a click you make on the panel
 * and a click the agent makes through `computer_click` meet at one pixel.
 *
 * @module dsh-plugin-computer-user/client
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { originFor, panelToScreen, screenToFrame, screenToPanel, type FrameMetrics } from './geometry.ts'

/** Services the panel needs from the client shell. */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

/** Tab kind: what `ctx.sidebarRight.openTab` names. */
const TAB_KIND = 'computer-vision'

/** Tab implementation id; also the key the pane body registers under. */
const TAB_ID = '@asun-labs/dsh-plugin-computer-user'

const BASE = 'api/computer-user/'

/** How long a click ripple stays on screen. */
const RIPPLE_MS = 1600

/** How many trail points are drawn behind the virtual pointer. */
const TRAIL_LENGTH = 48

/** Zoom bounds, as a multiplier on the fit scale. */
const MIN_ZOOM_FACTOR = 1
const MAX_ZOOM_FACTOR = 12

interface Frame {
  path: string
  width: number
  height: number
  virtualOffset: [number, number]
  scale: number
  viewport: { width: number; height: number }
  at: number
  region?: [number, number, number, number]
}

interface Overlay {
  id: number
  kind: 'cursor' | 'click' | 'type' | 'key' | 'hint' | 'agent-cursor'
  x: number
  y: number
  at: number
  text?: string
  action?: string
}

interface Instruction {
  id: number
  x: number
  y: number
  text?: string
  at: number
}

interface Snapshot {
  revision: number
  frame: Frame | null
  cursor: { x: number; y: number }
  overlays: Overlay[]
  instructions: Instruction[]
  realCursor: { x: number; y: number } | null
}

interface Status {
  mode: string
  linkMode: 'virtual' | 'real'
  captureIntervalMs: number
  platform: string
  frame: Frame | null
  cursor: { x: number; y: number }
}

type Event =
  | { type: 'overlay'; overlay: Overlay; cursor: { x: number; y: number } }
  | { type: 'clear'; scope: 'overlays' | 'all' }
  | { type: 'instruction'; instruction: Instruction }

const EMPTY_SNAPSHOT: Snapshot = {
  revision: 0,
  frame: null,
  cursor: { x: 0, y: 0 },
  overlays: [],
  instructions: [],
  realCursor: null,
}

function endpoint(path: string): string {
  return new URL(BASE + path, document.baseURI).toString()
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint(path), { credentials: 'same-origin', ...options })
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value
      ? String((value as { error: unknown }).error)
      : `Request failed (${response.status})`
    throw new Error(message)
  }
  return value as T
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** The frame's natural pixels plus the capture's geometry, for the shared math. */
function metricsOf(frame: Frame): FrameMetrics {
  return {
    width: frame.width,
    height: frame.height,
    virtualOffset: frame.virtualOffset,
    scale: frame.scale,
  }
}

/** True when the language is Chinese, so the panel can be bilingual like the rest of the app. */
function useChinese(): boolean {
  const [zh, setZh] = useState(() => document.documentElement.lang.toLowerCase().startsWith('zh'))
  useEffect(() => {
    const observer = new MutationObserver(() => setZh(document.documentElement.lang.toLowerCase().startsWith('zh')))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => observer.disconnect()
  }, [])
  return zh
}

/**
 * Poll the snapshot over SSE, falling back to refetching on a revision bump.
 *
 * The events only carry overlays; anything else (a new frame, a cleared board)
 * arrives as a `revision` ping and triggers one `/vision` read, so the panel
 * never pulls a full snapshot per overlay.
 */
function useSnapshot(zh: boolean): { snapshot: Snapshot; status: Status | null; error: string; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const revision = useRef(-1)

  const refresh = useCallback(() => {
    void request<Snapshot & Status>('vision').then(next => {
      revision.current = next.revision
      setSnapshot({
        revision: next.revision,
        frame: next.frame,
        cursor: next.cursor,
        overlays: next.overlays ?? [],
        instructions: next.instructions ?? [],
        realCursor: next.realCursor ?? null,
      })
      setError('')
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  useEffect(() => {
    void request<Status>('status').then(setStatus).catch(() => undefined)
    refresh()
    const source = new EventSource(endpoint('events'))
    source.onmessage = message => {
      try {
        const event = JSON.parse(message.data) as Event
        setSnapshot(current => applyEvent(current, event))
      } catch { /* a malformed frame is not worth tearing the stream down for */ }
    }
    // A snapshot-only change (new frame, cleared overlays).
    source.addEventListener('revision', event => {
      const next = Number((event as MessageEvent).data)
      if (!Number.isFinite(next) || next !== revision.current) refresh()
    })
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setError(zh ? '实时连接已关闭，正在重试…' : 'Live connection closed; retrying…')
      }
    }
    return () => source.close()
  }, [refresh, zh])

  return { snapshot, status, error, refresh }
}

/** Fold one incremental event into the snapshot. */
function applyEvent(current: Snapshot, event: Event): Snapshot {
  switch (event.type) {
    case 'overlay': {
      const overlays = [...current.overlays, event.overlay].slice(-240)
      return { ...current, overlays, cursor: event.cursor }
    }
    case 'clear':
      return {
        ...current,
        overlays: [],
        ...(event.scope === 'all' ? { instructions: [] } : {}),
      }
    case 'instruction':
      return { ...current, instructions: [...current.instructions, event.instruction].slice(-50) }
    default:
      return current
  }
}

/** One toolbar button, so the control set stays visually uniform. */
function ToolButton({ active, onClick, title, children, disabled }: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`cu-btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      title={title}
      disabled={disabled === true}
    >
      {children}
    </button>
  )
}

/**
 * The panel body: snapshot plus overlay layer plus the guidance controls.
 *
 * Everything drawn on top of the image is positioned through
 * {@link screenToPanel}, which is why the overlay layer and the image share one
 * transform — they cannot drift apart when the pane is resized.
 */
function VisionPanel() {
  const zh = useChinese()
  const t = useCallback((chinese: string, english: string) => (zh ? chinese : english), [zh])
  const { snapshot, status, error, refresh } = useSnapshot(zh)

  const viewportElement = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [zoomFactor, setZoomFactor] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [follow, setFollow] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const frame = snapshot.frame

  // Measure the viewport, since every transform hangs off its size.
  useEffect(() => {
    const element = viewportElement.current
    if (!element) return
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A slow clock so ripples and the trail fade without a full render loop.
  const hasFresh = snapshot.overlays.some(overlay => Date.now() - overlay.at < RIPPLE_MS)
  useEffect(() => {
    if (!hasFresh) return
    const timer = window.setInterval(() => setNow(Date.now()), 120)
    return () => window.clearInterval(timer)
  }, [hasFresh])

  const metrics = frame ? metricsOf(frame) : null

  // The fit scale keeps the snapshot whole and, critically, keeps its aspect
  // ratio: `originFor` centres whatever is left over, so the picture is
  // letterboxed rather than stretched.
  const fit = useMemo(() => {
    if (!frame || viewport.width <= 0 || viewport.height <= 0) return 1
    return Math.min(viewport.width / frame.width, viewport.height / frame.height)
  }, [frame, viewport.width, viewport.height])

  const display = useMemo(() => {
    if (!frame) return { width: 0, height: 0 }
    const scale = fit * zoomFactor
    return { width: frame.width * scale, height: frame.height * scale }
  }, [frame, fit, zoomFactor])

  const origin = useMemo(() => originFor(pan, display, viewport), [pan, display, viewport])

  // Follow mode keeps the virtual pointer on screen, which is what makes a
  // zoomed-in view usable while the agent works elsewhere on the desktop. The
  // desired pan is computed straight from the cursor, so this is a pure function
  // of the cursor — and the bail-out below stops it writing a state update that
  // would re-run the effect with an unchanged value.
  useEffect(() => {
    if (!follow || !frame || !metrics || zoomFactor <= 1) return
    const framePoint = screenToFrame(snapshot.cursor, metrics)
    const scaled = { width: display.width / frame.width, height: display.height / frame.height }
    const desired = originFor(
      {
        x: viewport.width / 2 - framePoint.x * scaled.width - (viewport.width - display.width) / 2,
        y: viewport.height / 2 - framePoint.y * scaled.height - (viewport.height - display.height) / 2,
      },
      display,
      viewport,
    )
    setPan(current => {
      const currentOrigin = originFor(current, display, viewport)
      return currentOrigin.x === desired.x && currentOrigin.y === desired.y
        ? current
        : { x: current.x + (desired.x - currentOrigin.x), y: current.y + (desired.y - currentOrigin.y) }
    })
  }, [follow, frame, metrics, zoomFactor, snapshot.cursor, display, viewport])

  // Every overlay is positioned once and reused by both the SVG-free overlay
  // layer and the trail, so the two can never disagree.
  const placed = useMemo(() => {
    if (!frame || !metrics) return []
    return snapshot.overlays
      .filter(overlay => overlay.kind !== 'hint' && now - overlay.at < RIPPLE_MS)
      .map(overlay => ({ overlay, at: screenToPanel(overlay, origin, display, metrics) }))
  }, [snapshot.overlays, frame, metrics, origin, display, now])

  const trail = useMemo(() => {
    if (!frame || !metrics) return []
    return snapshot.overlays
      .filter(overlay => overlay.kind === 'agent-cursor')
      .slice(-TRAIL_LENGTH)
      .map(overlay => ({ id: overlay.id, at: screenToPanel(overlay, origin, display, metrics) }))
  }, [snapshot.overlays, frame, metrics, origin, display])

  const cursorAt = useMemo(() => {
    if (!frame || !metrics) return null
    return screenToPanel(snapshot.cursor, origin, display, metrics)
  }, [snapshot.cursor, frame, metrics, origin, display])

  /** Panel-relative content coordinate → screen pixels. */
  const toScreen = useCallback((contentX: number, contentY: number) => {
    if (!metrics) return null
    return panelToScreen({ x: contentX + origin.x, y: contentY + origin.y }, origin, display, metrics)
  }, [metrics, origin, display])

  const captureNow = useCallback(() => {
    setBusy(true)
    setNotice('')
    void post<Frame>('capture', { keep_overlays: true })
      .then(() => { setNotice(t('已刷新快照', 'Snapshot refreshed')); refresh() })
      .catch(cause => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }, [refresh, t])

  const switchLinkMode = useCallback((mode: 'virtual' | 'real') => {
    setBusy(true)
    void post<{ link_mode: string }>('settings', { link_mode: mode })
      .then(() => setNotice(mode === 'real'
        ? t('已切换到 real：智能体会真正控制本机鼠标键盘', 'Switched to real: the agent will drive this machine')
        : t('已切换到 virtual：动作只作用在快照上', 'Switched to virtual: actions stay on the snapshot')))
      .catch(cause => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }, [t])

  const sendHint = useCallback((screenX: number, screenY: number) => {
    const text = note.trim()
    void post('hint', { x: Math.round(screenX), y: Math.round(screenY), ...(text ? { text } : {}) })
      .then(() => { setNote(''); setNotice(t('已记为指示，智能体下次读取即可看到', 'Recorded; the agent will see it on its next read')) })
      .catch(cause => setNotice(cause instanceof Error ? cause.message : String(cause)))
  }, [note, t])

  // A click with no modifier is guidance; with shift it is a pan grab. That
  // split keeps the "point at things" gesture as the default one.
  const dragging = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const moved = useRef(false)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (!event.shiftKey && zoomFactor <= 1) return
    dragging.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    moved.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true
    setPan({ x: drag.panX + dx, y: drag.panY + dy })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current
    dragging.current = null
    if (!drag) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    // A drag that never moved is a click, which means the user meant to point.
    if (moved.current || !metrics) return
    const rect = event.currentTarget.getBoundingClientRect()
    const screen = toScreen(event.clientX - rect.left, event.clientY - rect.top)
    if (screen) sendHint(screen.x, screen.y)
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const direction = event.deltaY < 0 ? 1.15 : 1 / 1.15
    setZoomFactor(current => Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, current * direction)))
  }

  const zoomTo = (next: number) => setZoomFactor(Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, next)))
  const isOneToOne = Math.abs(fit * zoomFactor - 1) < 0.01
  const percent = Math.round(fit * zoomFactor * 100)

  const frameUrl = frame
    ? `${endpoint('frame')}?path=${encodeURIComponent(frame.path)}&t=${frame.at}`
    : ''

  const linkMode = status?.linkMode ?? 'virtual'
  const platformUnsupported = status !== null && status.platform !== 'win32'

  return (
    <section className="cu-panel" aria-label={t('电脑操作快照', 'Computer Use snapshot')}>
      <style>{panelCss}</style>

      <header className="cu-toolbar">
        <div className={`cu-badge ${linkMode === 'real' ? 'is-real' : 'is-virtual'}`}
          title={linkMode === 'real'
            ? t('real：动作会真正注入本机鼠标键盘', 'real: actions are injected into this machine')
            : t('virtual：动作只作用在这张快照上，你的桌面不受影响', 'virtual: actions only affect this snapshot')}>
          <i />
          {linkMode === 'real' ? t('实机接管', 'Real desktop') : t('虚拟快照', 'Virtual snapshot')}
        </div>
        <ToolButton onClick={() => switchLinkMode(linkMode === 'virtual' ? 'real' : 'virtual')} disabled={busy}
          title={linkMode === 'virtual'
            ? t('切换到 real：让智能体真正操作本机', 'Switch to real: let the agent drive this machine')
            : t('切换回 virtual：只在此面板演示', 'Switch back to virtual: rehearse on this panel only')}>
          {linkMode === 'virtual' ? t('→ real', '→ real') : t('→ virtual', '→ virtual')}
        </ToolButton>
        <span className="cu-spacer" />
        <ToolButton onClick={() => zoomTo(zoomFactor / 1.25)} disabled={zoomFactor <= MIN_ZOOM_FACTOR} title={t('缩小', 'Zoom out')}>−</ToolButton>
        <span className="cu-percent" title={t('面板像素 : 快照像素', 'panel pixels : snapshot pixels')}>{percent}%</span>
        <ToolButton onClick={() => zoomTo(zoomFactor * 1.25)} disabled={zoomFactor >= MAX_ZOOM_FACTOR} title={t('放大', 'Zoom in')}>＋</ToolButton>
        <ToolButton onClick={() => zoomTo(1)} active={zoomFactor === 1} title={t('适应窗口（完整显示、等比）', 'Fit the pane (whole snapshot, aspect kept)')}>{t('适应', 'Fit')}</ToolButton>
        <ToolButton onClick={() => zoomTo(1 / fit)} active={isOneToOne} title={t('1:1 原始像素', '1:1 original pixels')}>1:1</ToolButton>
        <ToolButton onClick={() => setFollow(value => !value)} active={follow} title={t('跟随虚拟光标', 'Follow the virtual pointer')}>{t('跟随', 'Follow')}</ToolButton>
        <ToolButton onClick={captureNow} disabled={busy || platformUnsupported} title={t('立即刷新快照', 'Capture now')}>{busy ? '…' : '⟳'}</ToolButton>
      </header>

      <div
        ref={viewportElement}
        className={`cu-viewport${zoomFactor > 1 ? ' is-pannable' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      >
        {!frame && <div className="cu-empty">
          <strong>{t('还没有快照', 'No snapshot yet')}</strong>
          <p>{platformUnsupported
            ? t('当前平台不是 Windows，截图与输入注入仅在 Windows 上可用。', 'This platform is not Windows; capture and input injection need Windows.')
            : t('点击工具栏的 ⟳ 抓取一次，或在对话中让智能体调用 computer_screenshot。之后这里会自动保持最新。',
              'Press ⟳ in the toolbar, or have the agent call computer_screenshot. After that this stays live.')}</p>
        </div>}

        {frame && <>
          <img
            className="cu-frame"
            src={frameUrl}
            alt={t('桌面快照', 'Desktop snapshot')}
            draggable={false}
            style={{ left: origin.x, top: origin.y, width: display.width, height: display.height }}
          />
          <div className="cu-overlays" style={{ left: origin.x, top: origin.y, width: display.width, height: display.height }}>
            {trail.map((point, index) => (
              <span key={point.id} className="cu-trail"
                style={{
                  left: point.at.x - origin.x,
                  top: point.at.y - origin.y,
                  opacity: ((index + 1) / trail.length) * 0.45,
                  transform: `scale(${0.4 + ((index + 1) / trail.length) * 0.6})`,
                }} />
            ))}
            {placed.map(({ overlay, at }) => {
              const age = now - overlay.at
              const progress = Math.min(1, age / RIPPLE_MS)
              const style = { left: at.x - origin.x, top: at.y - origin.y }
              if (overlay.kind === 'click') {
                return <span key={overlay.id} className={`cu-ripple${overlay.action === 'right_click' ? ' is-right' : ''}`}
                  style={{ ...style, opacity: 1 - progress, transform: `scale(${0.6 + progress * 2.2})` }} />
              }
              if (overlay.kind === 'type' || overlay.kind === 'key') {
                return <span key={overlay.id} className="cu-label" style={{ ...style, opacity: 1 - progress }}>
                  {overlay.kind === 'key' ? `⌨ ${overlay.text ?? ''}` : `⌨ ${overlay.text ?? ''}`}
                </span>
              }
              return null
            })}
            {cursorAt && <>
              <span className="cu-cursor-ring" style={{ left: cursorAt.x - origin.x, top: cursorAt.y - origin.y }} />
              <svg className="cu-cursor" style={{ left: cursorAt.x - origin.x, top: cursorAt.y - origin.y }}
                width="18" height="24" viewBox="0 0 18 24" aria-hidden="true">
                <path d="M2 1 L2 18 L6.4 13.8 L9.6 21 L12.4 19.6 L9.2 12.6 L15.6 12.2 Z"
                  fill="#ffffff" stroke="#111827" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            </>}
          </div>
          {snapshot.overlays.filter(overlay => overlay.kind === 'hint').slice(-24).map(overlay => {
            const at = metrics ? screenToPanel(overlay, origin, display, metrics) : { x: 0, y: 0 }
            return <button key={`hint-${overlay.id}`} type="button" className="cu-pin"
              style={{ left: at.x, top: at.y }}
              onClick={() => void post('hint-clear', { id: instructionFor(snapshot, overlay) }).then(refresh).catch(() => undefined)}
              title={t('移除这条指示', 'Remove this instruction')}>
              <b>{t('指示', 'Note')}</b>{overlay.text ? <em>{overlay.text}</em> : null}
            </button>
          })}
        </>}
      </div>

      <div className="cu-note-row">
        <input
          className="cu-note"
          value={note}
          placeholder={t('可选：写下要点，然后点击快照上的位置', 'Optional: type a note, then click the snapshot')}
          onChange={event => setNote(event.target.value)}
        />
        <span className="cu-hint-help">{t('左键点击=给智能体指路 · Shift+拖动=平移 · Ctrl+滚轮=缩放', 'Click = point for the agent · Shift+drag = pan · Ctrl+wheel = zoom')}</span>
      </div>

      <footer className="cu-footer">
        {error ? <span className="cu-error">{error}</span> : notice
          ? <span className="cu-notice">{notice}</span>
          : <span>
            {frame
              ? <>{frame.width}×{frame.height}px · {t('视口', 'viewport')} {Math.round(frame.viewport.width)}×{Math.round(frame.viewport.height)}
                {frame.region ? ` · ${t('局部', 'region')} [${frame.region.map(value => value.toFixed(2)).join(', ')}]` : ''}
                {' · '}{t('光标', 'pointer')} [{Math.round(snapshot.cursor.x)}, {Math.round(snapshot.cursor.y)}]
                {snapshot.realCursor ? ` · ${t('真实', 'real')} [${Math.round(snapshot.realCursor.x)}, ${Math.round(snapshot.realCursor.y)}]` : ''}
                {' · '}{t('刷新', 'refresh')} {status?.captureIntervalMs ? `${status.captureIntervalMs}ms` : t('关', 'off')}
              </>
              : t('等待第一次快照…', 'Waiting for the first snapshot…')}
          </span>}
      </footer>

      {snapshot.instructions.length > 0 && <div className="cu-instructions">
        <header>
          <strong>{t('待处理的指示', 'Pending instructions')} · {snapshot.instructions.length}</strong>
          <button type="button" onClick={() => void post('hint-clear', { scope: 'all' }).then(refresh).catch(() => undefined)}>
            {t('全部清除', 'Clear all')}
          </button>
        </header>
        <ul>
          {snapshot.instructions.slice(-6).reverse().map(instruction => (
            <li key={instruction.id}>
              <code>[{Math.round(instruction.x)}, {Math.round(instruction.y)}]</code>
              {instruction.text ? <span>{instruction.text}</span> : null}
              <button type="button" title={t('移除', 'Remove')}
                onClick={() => void post('hint-clear', { id: instruction.id }).then(refresh).catch(() => undefined)}>×</button>
            </li>
          ))}
        </ul>
      </div>}
    </section>
  )
}

/** Match a hint overlay back to the instruction it came from, so removing either removes both. */
function instructionFor(snapshot: Snapshot, overlay: Overlay): number {
  const match = snapshot.instructions.find(instruction => instruction.x === overlay.x && instruction.y === overlay.y)
  return match?.id ?? overlay.id
}

/** The settings card, mirroring the plugin's own settings route. */
function SettingsPage() {
  const zh = useChinese()
  const t = (chinese: string, english: string) => (zh ? chinese : english)
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void request<Record<string, unknown>>('settings').then(setSettings).catch(cause => setNotice(String(cause)))
  }, [])

  if (!settings) return <p className="cu-settings-loading">{notice || t('正在读取配置…', 'Loading settings…')}</p>

  const modes: Array<[string, string, string]> = [
    ['disabled', t('禁用', 'Disabled'), t('拒绝全部工具调用', 'Refuse every tool call')],
    ['readonly', t('只读', 'Read-only'), t('仅截图 / 读光标 / 读视觉信息', 'Screenshot, cursor, and vision reads only')],
    ['manual', t('手动批准', 'Manual approval'), t('需在对话中输入 /computer 批准后才可操作', 'Needs /computer approval in the conversation')],
    ['auto', t('自动', 'Automatic'), t('LLM 可自由调用全部工具', 'The model may call everything')],
  ]
  const linkModes: Array<[string, string, string]> = [
    ['virtual', t('虚拟快照（默认）', 'Virtual snapshot (default)'), t('鼠标键盘只作用在右侧面板的快照上，你的桌面与光标完全不受影响', 'Mouse and keyboard only affect the sidebar snapshot; your desktop and cursor stay untouched')],
    ['real', t('实机接管', 'Real desktop'), t('Win32 SendInput 真正注入本机，智能体会占用真实光标', 'Win32 SendInput drives this machine; the agent takes over the real cursor')],
  ]

  const patch = (key: string, value: unknown) => setSettings({ ...settings, [key]: value })
  const save = () => {
    setBusy(true)
    void post<Record<string, unknown>>('settings', settings).then(next => {
      setSettings(next)
      setNotice(t('已保存', 'Saved'))
    }).catch(cause => setNotice(String(cause))).finally(() => setBusy(false))
  }

  const options = (values: Array<[string, string, string]>, key: string) => (
    <div className="cu-options">
      {values.map(([value, label, hint]) => (
        <label key={value} className={`cu-option${settings[key] === value ? ' is-active' : ''}`}>
          <input type="radio" name={key} checked={settings[key] === value} onChange={() => patch(key, value)} />
          <span><b>{label}</b><small>{hint}</small></span>
        </label>
      ))}
    </div>
  )

  return (
    <section className="cu-settings">
      <style>{settingsCss}</style>
      <h2>{t('电脑操作', 'Computer Use')}</h2>
      <p className="cu-settings-intro">
        {t('computer-user：让 DSH 看到屏幕并操作鼠标键盘。本插件的重点是把「看到」和「操作」都放进右侧边栏的实时快照里——你可以随时看着它做事，也可以随时打断。',
          'computer-user lets DSH see the screen and drive mouse and keyboard. This fork puts both the seeing and the acting into a live right-sidebar snapshot, so you can watch it work and take the wheel back at any moment.')}
      </p>

      <div className="cu-settings-card">
        <h3>{t('动作落点', 'Where actions land')}</h3>
        {options(linkModes, 'link_mode')}
        <p className="cu-settings-hint">
          {t('virtual 模式下智能体仍旧截图、仍旧「点击」，但那支鼠标活在右侧快照上：他玩他的，不妨碍你。切到 real 才会真正注入本机输入。',
            'In virtual mode the agent still screenshots and still "clicks", but that pointer lives on the sidebar snapshot — it plays its own game without touching yours. Only real injects input into this machine.')}
        </p>
      </div>

      <div className="cu-settings-card">
        <h3>{t('运行模式', 'Run mode')}</h3>
        {options(modes, 'mode')}
      </div>

      <div className="cu-settings-card">
        <h3>{t('高级', 'Advanced')}</h3>
        <label className="cu-settings-row">
          <span><b>{t('快照刷新间隔', 'Snapshot refresh interval')}</b><small>{t('毫秒；0 = 不自动刷新。仅影响预览节奏。', 'Milliseconds; 0 disables. Affects the preview cadence only.')}</small></span>
          <input type="number" min={0} max={60000} step={100}
            value={String(settings.capture_interval_ms ?? 1500)}
            onChange={event => patch('capture_interval_ms', Number(event.target.value))} />
        </label>
        <label className="cu-settings-row">
          <span><b>{t('截图输出目录', 'Screenshot directory')}</b><small>{t('留空使用系统临时目录', 'Empty uses the OS temp directory')}</small></span>
          <input type="text" value={String(settings.screenshot_dir ?? '')}
            onChange={event => patch('screenshot_dir', event.target.value)} />
        </label>
        <label className="cu-settings-row">
          <span><b>{t('逐字输入间隔', 'Typing interval')}</b><small>{t('毫秒，越大越稳但越慢', 'Milliseconds; higher is steadier but slower')}</small></span>
          <input type="number" min={0} max={500} value={String(settings.typing_interval_ms ?? 0)}
            onChange={event => patch('typing_interval_ms', Number(event.target.value))} />
        </label>
        <label className="cu-settings-row">
          <span><b>{t('滚动刻度', 'Scroll units')}</b><small>{t('一次 scroll 滚动多少格（每格 120）', 'Wheel notches per scroll (120 each)')}</small></span>
          <input type="number" min={1} max={20} value={String(settings.scroll_units ?? 1)}
            onChange={event => patch('scroll_units', Number(event.target.value))} />
        </label>
        <label className="cu-settings-row is-check">
          <span><b>{t('AI 可自行修改模式', 'AI may change modes')}</b><small>{t('开启后 AI 才能调用 computer_set_mode / computer_set_link_mode', 'Lets the model call computer_set_mode / computer_set_link_mode')}</small></span>
          <input type="checkbox" checked={settings.ai_can_change_mode === true}
            onChange={event => patch('ai_can_change_mode', event.target.checked)} />
        </label>
        <label className="cu-settings-row is-check">
          <span><b>{t('代码输出打回', 'Reject code-as-text output')}</b><small>{t('模型把工具调用写成对话文本时打回并提示', 'Bounces tool calls written as conversation text')}</small></span>
          <input type="checkbox" checked={settings.output_guard !== false}
            onChange={event => patch('output_guard', event.target.checked)} />
        </label>
        <label className="cu-settings-row is-check">
          <span><b>{t('调试日志', 'Debug logging')}</b><small>{t('在 Host 日志中输出更多细节', 'More detail in the host log')}</small></span>
          <input type="checkbox" checked={settings.debug === true}
            onChange={event => patch('debug', event.target.checked)} />
        </label>
      </div>

      <div className="cu-settings-actions">
        <button type="button" className="cu-primary" onClick={save} disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button>
        {notice ? <span className="cu-settings-notice">{notice}</span> : null}
      </div>
    </section>
  )
}

/**
 * Client plugin body.
 * @param ctx - client context carrying the slot registry and the right sidebar's services.
 */
export function apply(ctx: Context): void {
  const guideEntry = {
    id: 'computer-user',
    order: 110,
    title: () => '电脑操作',
    description: () => '实时快照、虚拟光标与用户指示',
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => '电脑操作',
    guide: [guideEntry],
  }), 'computer-user: rightbar tab type')

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    VisionPanel,
  ))
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'computer-user', order: 50, label: () => '电脑操作' },
    SettingsPage,
  ))
}

const panelCss = `
.cu-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:#0b1020;color:#e4ebf7;font:12px Inter,system-ui,sans-serif}
.cu-panel button{color:inherit;cursor:pointer;font:inherit}
.cu-toolbar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #293750;flex-wrap:wrap}
.cu-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:600;border:1px solid transparent}
.cu-badge i{width:7px;height:7px;border-radius:50%;background:currentColor}
.cu-badge.is-virtual{background:#123a2a;color:#4ade80;border-color:#1f6b4a}
.cu-badge.is-real{background:#3a1616;color:#f87171;border-color:#7f2b2b}
.cu-spacer{flex:1}
.cu-btn{height:26px;min-width:26px;padding:0 8px;border:1px solid #344157;border-radius:7px;background:#1b263a;font-size:11px}
.cu-btn:hover:not(:disabled){border-color:#7aa2ff}
.cu-btn.is-active{border-color:#7aa2ff;background:#253b65}
.cu-btn:disabled{opacity:.4;cursor:default}
.cu-percent{min-width:44px;text-align:center;color:#93a1b8;font-variant-numeric:tabular-nums}
.cu-viewport{position:relative;flex:1;min-height:0;overflow:hidden;background:#06080f;touch-action:none}
.cu-viewport.is-pannable{cursor:grab}
.cu-viewport.is-pannable:active{cursor:grabbing}
.cu-frame{position:absolute;user-select:none;-webkit-user-drag:none;image-rendering:auto}
.cu-overlays{position:absolute;pointer-events:none}
.cu-trail{position:absolute;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#7aa2ff;box-shadow:0 0 6px #7aa2ff}
.cu-ripple{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #ffd166;box-shadow:0 0 12px #ffd16688}
.cu-ripple.is-right{border-color:#f87171;box-shadow:0 0 12px #f8717188}
.cu-label{position:absolute;transform:translate(12px,-50%);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;padding:2px 7px;border-radius:6px;background:#111827e6;border:1px solid #42516b;color:#dbe6ff;font-size:11px}
.cu-cursor{position:absolute;margin:-2px 0 0 -2px;filter:drop-shadow(0 1px 3px #000c)}
.cu-cursor-ring{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #7aa2ff88;animation:cu-pulse 1.6s ease-out infinite}
@keyframes cu-pulse{0%{transform:scale(.75);opacity:.9}100%{transform:scale(1.35);opacity:0}}
.cu-pin{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;gap:1px;align-items:flex-start;max-width:210px;padding:5px 8px;border-radius:8px;border:1px solid #d97706;background:#3b240aee;color:#fde68a;font-size:11px;text-align:left;box-shadow:0 6px 18px #0007;pointer-events:auto}
.cu-pin::after{content:'';position:absolute;left:50%;bottom:-5px;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);background:#3b240a;border-right:1px solid #d97706;border-bottom:1px solid #d97706}
.cu-pin b{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#fbbf24}
.cu-pin em{font-style:normal;color:#fef3c7;overflow:hidden;text-overflow:ellipsis}
.cu-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:26px;text-align:center;color:#93a1b8}
.cu-empty strong{color:#e4ebf7;font-size:13px}
.cu-empty p{max-width:340px;line-height:1.6}
.cu-note-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid #293750;flex-wrap:wrap}
.cu-note{flex:1;min-width:180px;height:28px;padding:0 9px;border:1px solid #344157;border-radius:7px;background:#0f1729;color:inherit;font:inherit}
.cu-note:focus{outline:none;border-color:#7aa2ff}
.cu-hint-help{color:#7c8aa3;font-size:10px}
.cu-footer{padding:6px 10px;border-top:1px solid #293750;color:#93a1b8;font-size:10px;font-variant-numeric:tabular-nums}
.cu-error{color:#ff8f8f}
.cu-notice{color:#7dd3a0}
.cu-instructions{border-top:1px solid #293750;max-height:150px;overflow:auto}
.cu-instructions header{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;color:#93a1b8;font-size:11px}
.cu-instructions header button{border:1px solid #344157;border-radius:6px;background:#1b263a;padding:3px 8px;font-size:10px}
.cu-instructions ul{list-style:none;margin:0;padding:0 10px 10px;display:flex;flex-direction:column;gap:5px}
.cu-instructions li{display:flex;align-items:center;gap:7px;background:#131c2e;border:1px solid #293750;border-radius:7px;padding:5px 8px}
.cu-instructions code{color:#ffd166;font-size:11px}
.cu-instructions li span{flex:1;color:#c7d3e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cu-instructions li button{border:0;background:transparent;color:#93a1b8;font-size:14px;line-height:1}
@media(max-width:560px){.cu-hint-help{display:none}}
`

const settingsCss = `
.cu-settings{display:flex;flex-direction:column;gap:14px;padding:22px;max-width:760px;color:var(--dsw-alias-label-primary,#e4e4e7);font:14px Inter,system-ui,sans-serif}
.cu-settings h2{margin:0;font-size:18px}
.cu-settings h3{margin:0;font-size:13px;font-weight:600}
.cu-settings-intro{margin:0;line-height:1.6;color:var(--dsw-alias-label-secondary,#a1a1aa)}
.cu-settings-loading{color:var(--dsw-alias-label-secondary,#a1a1aa)}
.cu-settings-card{display:flex;flex-direction:column;gap:10px;border:1px solid #6664;border-radius:12px;padding:14px 16px}
.cu-settings-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#a1a1aa)}
.cu-options{display:flex;flex-direction:column;gap:7px}
.cu-option{display:flex;align-items:flex-start;gap:9px;border:1px solid #6664;border-radius:9px;padding:9px 11px;cursor:pointer}
.cu-option.is-active{border-color:#4e79c9;background:#4e79c918}
.cu-option input{margin-top:3px}
.cu-option span{display:flex;flex-direction:column;gap:3px}
.cu-option small{color:var(--dsw-alias-label-secondary,#a1a1aa);line-height:1.5}
.cu-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #6663;padding:8px 0}
.cu-settings-row:last-child{border-bottom:0}
.cu-settings-row span{display:flex;flex-direction:column;gap:3px}
.cu-settings-row small{color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px}
.cu-settings-row input[type=text],.cu-settings-row input[type=number]{min-width:190px;max-width:300px;width:42%;background:#7772;color:inherit;border:1px solid #8885;border-radius:8px;padding:8px}
.cu-settings-actions{display:flex;align-items:center;gap:10px}
.cu-primary{border:0;border-radius:9px;background:#4e79c9;color:#fff;padding:9px 18px;cursor:pointer}
.cu-primary:disabled{opacity:.5;cursor:default}
.cu-settings-notice{color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px}
`
