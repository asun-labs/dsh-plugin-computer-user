# dsh-plugin-computer-user

**Virtual-desktop computer use for DeepSeek Harness.** The agent sees your screen
in the right sidebar and its mouse acts on that snapshot — not on your real
cursor. It plays its own game; you keep your computer.

A fork of [jing-hy/computer-user](https://github.com/jing-hy/computer-user) that
adds the half it was missing: a visualization.

---

## The problem

Upstream `computer-user` gives a text-only model genuine control of a Windows
machine. It works, but you cannot see any of it:

- `computer_screenshot` writes a PNG to a temp directory **for the model's eyes
  only**. You never see what it is looking at.
- `computer_click` moves **your actual cursor** and clicks. While the agent
  works, the machine is not yours.
- You find out what happened afterwards, from the conversation.

For a long autonomous task that is a bad deal: you cannot tell whether it is
about to click the wrong thing, and you cannot use your own computer meanwhile.

## What this fork changes

**A live snapshot in the right sidebar.** Every capture the agent makes is
published to a dockable panel: the screen, the agent's virtual pointer moving
across it, click ripples, the text it types, the keys it presses. You watch the
work in progress.

**Actions land on the snapshot by default.** `link_mode: virtual` means the
agent still screenshots, still "clicks", still "types" — but that pointer lives
on the panel. Nothing reaches Win32 `SendInput`, so your cursor, your focus, and
your window layout are untouched. The agent plays in the picture; your desktop
is yours.

**Flip to real when you mean it.** One toolbar button (or the settings card)
switches `link_mode` to `real`, and now the Win32 path runs — with the panel
still mirroring what happens, so `real` mode is visible rather than a hijack.

**You can point at things.** Click anywhere on the snapshot, optionally with a
note, and that becomes a queued instruction with an exact screen coordinate. The
agent reads them through `computer_get_vision`, so "click *this*" stops being a
description problem.

**The agent gets numbers, not just a picture.** `computer_get_vision` reports the
captured size, the virtual-screen origin, the capture scale, the current
pointer, the frame's age, and your pending hints. Combined with the panel, the
look-act-verify loop closes on both sides.

## How the two halves fit together

| | upstream | this fork |
|---|---|---|
| capture | PNG to disk for the model | **same PNG, published to the sidebar** |
| pointer | real cursor via SendInput | **virtual pointer on the snapshot** (default) |
| typing / keys | real keystrokes | **drawn on the snapshot** (default) |
| verification | screenshot again, read it | **screenshot again, watch it** |
| user input | none | **click the snapshot to point, with a note** |
| real control | always | **opt-in, one switch** |

Everything upstream did is still here: all nine `computer_*` tools, the four run
modes, `/computer` approval, the settings namespace, the output guard that
bounces tool calls written as prose, and the bundled PowerShell that needs no
native module.

## Install

```bash
pnpm install
pnpm run build          # → lib/index.js (host) + lib/client.js (browser)
```

Then add the package to your DSH profile as a plugin dependency. The bundle patch
in `cordis.patch.yml` inserts the plugin row and sets the defaults:

```yaml
- insert:
    - id: dsh-computer-user
      name: '@asun-labs/dsh-plugin-computer-user'
      config:
        mode: manual
        link_mode: virtual
```

## Settings

Settings → 电脑操作. The two that matter sit at the top:

**动作落点 (link_mode)**

- `virtual` *(default)* — mouse and keyboard only affect the sidebar snapshot.
  Your desktop and cursor are untouched.
- `real` — Win32 `SendInput` drives this machine. The agent takes the real cursor.

**运行模式 (mode)**

- `disabled` — refuse every tool call.
- `readonly` — screenshot, cursor, vision reads, wait.
- `manual` *(default)* — acting tools need `/computer` approval in the conversation.
- `auto` — the model may call everything.

Advanced: capture interval (how often the panel refreshes), screenshot directory,
typing interval, scroll units, whether the AI may change its own modes, the
output guard, and debug logging.

## The panel

| control | what it does |
|---|---|
| 虚拟快照 / 实机接管 badge | which mode is live, at a glance |
| `→ real` / `→ virtual` | switch `link_mode` in one click |
| `−` / `＋` / `%` | zoom; `100%` is real 1:1, one panel pixel per snapshot pixel |
| 适应 (Fit) | whole snapshot, centred, **aspect ratio preserved** |
| 1:1 | original pixels, scrolled if it does not fit |
| 跟随 (Follow) | pan automatically to keep the virtual pointer visible |
| `⟳` | capture now; otherwise the panel refreshes on the configured interval |

Gestures: **left click** = point for the agent (with the note field, if you typed
one), **Shift+drag** = pan when zoomed in, **Ctrl/⌘+wheel** = zoom.

The snapshot is never stretched. It is scaled by whichever axis fits and centred
on the other, so the shapes you see are the shapes on screen — which is what
makes clicking it meaningful.

## Architecture

```
src/
  index.ts         plugin body — tools, routes, capture loop, settings, /computer
  tools.ts         the 12 computer_* tools, the mode gate
  session.ts       VirtualSession — the board the panel renders (frames, overlays, hints)
  ports.ts         DesktopPort: real (SendInput) vs virtual (record only)
  geometry.ts      screen ↔ frame ↔ panel transforms (pure, shared by both halves)
  client.tsx       the sidebar panel + the settings card
  ps.ts            bundled PowerShell runner (base64 JSON payload)
  capture.ps1      DPI-aware multi-monitor screenshot  (upstream, unmodified)
  input.ps1        Win32 SendInput mouse + keyboard    (upstream, unmodified)
tests/             geometry, session, tools, gate, output guard
```

The split that makes the fork work is `ports.ts`: a tool asks a `DesktopPort` to
click, and whether that means "really click" or "draw a click on the panel" is
one swap. `link_mode` changes which port is returned; nothing else in the tool
layer knows the difference. It also means the whole tool set is testable without
touching a real desktop — the tests do exactly that. The Host keeps only the
latest 24 generated panel previews and removes its generated screenshots on an
orderly shutdown. A screenshot path supplied explicitly by a tool caller is not
managed by this cleanup.

`geometry.ts` is shared verbatim by both halves, which is why a click you make on
the panel and a click the agent makes through `computer_click` resolve to the
same screen pixel instead of merely close to it.

## Requirements

Windows. Tested with DSH `0.2.1-alpha.2`; the package also declares the earlier
`0.1.5` and `0.1.7` lines. Capture uses `System.Windows.Forms`/`System.Drawing` and input uses Win32
`SendInput`, both through the bundled PowerShell — no native module, no build
step, no external API. On other platforms the panel loads and reports that
capture and injection are unavailable.

## Attribution

Forked from [**computer-user**](https://github.com/jing-hy/computer-user) by
**jing-hy**, MIT licensed. The `computer_*` tool design, the run-mode gate, the
`/computer` approval flow, the settings namespace, the output guard, and both
PowerShell scripts come from that project; see [NOTICE](./NOTICE). The
visualization layer, the virtual/real port split, `computer_get_vision`,
`computer_set_link_mode`, and the sidebar panel are this fork's additions.

## License

MIT — see [LICENSE](./LICENSE).
