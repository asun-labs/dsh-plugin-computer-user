/**
 * dsh-plugin-computer-user / config.ts — settings schema.
 *
 * `link_mode` is the fork's reason to exist and sits at the top of the settings
 * card next to `mode`, because those two together answer "can the agent act,
 * and where does the action land".
 *
 * @module dsh-plugin-computer-user/config
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace for this plugin, as written to DSH's settings file. */
export const NS = 'computer-user'

/** Whether a tool call touches the real desktop or only the panel overlay. */
export type LinkMode = 'virtual' | 'real'

/** Runtime modes, in increasing order of what the agent may do on its own. */
export type RunMode = 'disabled' | 'readonly' | 'manual' | 'auto'

export const RUN_MODES: readonly RunMode[] = ['disabled', 'readonly', 'manual', 'auto']
export const LINK_MODES: readonly LinkMode[] = ['virtual', 'real']

export const Config: z<Settings> = z.object({
  mode: z
    .union([z.const('disabled'), z.const('readonly'), z.const('manual'), z.const('auto')])
    .default('manual')
    .description('运行模式：禁用=全部拒绝 | 只读=仅截图/读光标/等待 | 手动批准=需 /computer 批准 | 自动=LLM 自由调用')
    .volatile(),
  link_mode: z
    .union([z.const('virtual'), z.const('real')])
    .default('virtual')
    .description(
      '动作落点：virtual=鼠标键盘只作用在右侧快照上，你的真实桌面与光标完全不受影响（默认）；' +
      'real=真正注入本机 SendInput，智能体会占用真实光标'
    )
    .volatile(),
  capture_interval_ms: z
    .number()
    .default(1500)
    .description('面板快照自动刷新间隔（毫秒），设为 0 关闭自动刷新')
    .volatile(),
  max_capture_width: z
    .number()
    .default(1920)
    .description('面板预览的截图最大宽度（等比缩放，0 = 不限）；仅影响预览，不影响坐标换算')
    .volatile(),
  ai_can_change_mode: z
    .boolean()
    .default(false)
    .description('AI 是否可自行修改运行模式（computer_set_mode 是否可用），默认不可')
    .volatile(),
  screenshot_dir: z.string().default('').description('截图输出目录（空 = 系统临时目录）').volatile(),
  typing_interval_ms: z.number().default(0).description('逐字输入间隔（毫秒），越大越稳但越慢').volatile(),
  scroll_units: z.number().default(1).description('滚动刻度：一次 scroll 滚动多少格').volatile(),
  output_guard: z
    .boolean()
    .default(true)
    .description('LLM 输出过滤器：把工具调用写成对话文本时打回并提示，第二次同内容放行')
    .volatile(),
  debug: z.boolean().default(false).description('调试日志').volatile(),
})

/** Resolved settings, with every default applied. */
export interface Settings {
  mode: RunMode
  link_mode: LinkMode
  capture_interval_ms: number
  max_capture_width: number
  ai_can_change_mode: boolean
  screenshot_dir: string
  typing_interval_ms: number
  scroll_units: number
  output_guard: boolean
  debug: boolean
}

/** Settings as the agent-facing surface reads them: an unresolved snapshot. */
export type SettingsView = Partial<Settings>

/** The defaults above, as a plain object; avoids a schema parse when no settings service exists. */
export const SETTINGS_DEFAULTS: Settings = {
  mode: 'manual',
  link_mode: 'virtual',
  capture_interval_ms: 1500,
  max_capture_width: 1920,
  ai_can_change_mode: false,
  screenshot_dir: '',
  typing_interval_ms: 0,
  scroll_units: 1,
  output_guard: true,
  debug: false,
}

/**
 * Fold a partial settings snapshot onto the defaults, ignoring values that are
 * the wrong type — a settings file edited by hand can hold anything.
 * @param view - a snapshot, or nothing when no settings service is available.
 * @returns complete settings.
 */
export function resolveSettings(view: SettingsView | undefined): Settings {
  if (!view) return { ...SETTINGS_DEFAULTS }
  const merged: Settings = { ...SETTINGS_DEFAULTS }
  for (const key of Object.keys(SETTINGS_DEFAULTS) as Array<keyof Settings>) {
    const raw: unknown = view[key]
    const value: unknown = raw !== null && typeof raw === 'object'
      && 'get' in raw && typeof raw.get === 'function' ? raw.get() : raw
    if (value === undefined || value === null) continue
    if (typeof value !== typeof SETTINGS_DEFAULTS[key]) continue
    // Both enums are validated by the schema, but a hand-edited file is not.
    if (key === 'mode' && !RUN_MODES.includes(value as RunMode)) continue
    if (key === 'link_mode' && !LINK_MODES.includes(value as LinkMode)) continue
    Object.assign(merged, { [key]: value })
  }
  return merged
}
