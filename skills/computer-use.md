# 电脑操作（computer-use）—— 看屏幕 + 操作鼠标键盘（纯本地）

computer-user 插件提供 12 个 `computer_*` 工具，让纯文本模型像人手一样操作
Windows 桌面：读屏 → 定位目标 → 点击/输入/按键/滚动/拖拽 → 截图验证。与
picturereader 配合构成「看 → 想 → 做 → 验」闭环。

> **本插件的关键区别：动作默认落在「虚拟快照」上。**
> 右侧边栏（sidebar-right）会打开一个「电脑操作」面板，实时显示当前屏幕快照，
> 智能体的鼠标是画在这张快照上的虚拟指针，点击会有涟漪，输入会显示文本。
> 默认 `link_mode = virtual`，**不注入真实系统输入**：用户的鼠标、键盘焦点、
> 窗口布局都不受影响。
>
> 也就是说：屏幕上那张图里发生的一切是真的（截图是真的），但那只手是假的。
> 用户能在面板上看着你做，也能随时点快照给你指路。
>
> 只有设置里把「动作落点」切成 `real`，才会走 Win32 SendInput 真正操作本机。

> **隐私**：全程纯本地。读屏用 `computer_screenshot`（本地 PowerShell 截图），
> 分析用 picturereader 的 `image_scan` / `image_ocr`（本地像素分析 + 本机 OCR），
> 操作用 `computer_*`（本地）。**没有任何图像、坐标、页面元素会发往云端。**

---

## 先做哪一步：读 computer_get_vision

新增的 `computer_get_vision` 是这套工具的眼睛和坐标尺，**每次行动前先读它**：

- `frame.size` —— 快照 PNG 的像素尺寸
- `frame.virtual_offset` —— 虚拟屏原点，坐标都要加上它
- `frame.scale` —— 截图缩放（虚拟屏像素 = PNG 像素 ÷ scale）
- `frame.age_ms` —— 这张快照多久以前拍的（太大就先重新截图）
- `pointer` —— 当前虚拟指针位置（虚拟屏像素）
- `user_instructions` —— **用户在面板上点出来的坐标 + 备注**，这是最直接的意图
- `overlays` —— 最近画过的动作（点击、输入、按键）

`user_instructions` 有内容时，优先处理它：用户已经用鼠标告诉你目标在哪了。
处理完用 `computer_get_vision` 确认队列，需要清空时在面板上点「全部清除」。

---

## 标准闭环（每步都按这个顺序）

1. **看**：`computer_screenshot` 截屏 → 得到 `{ path, width, height, virtual_offset, scale }`。
   同一张图会立刻出现在用户的右侧面板上，所以你们看的是同一张图。
2. **读坐标**：`computer_get_vision` 拿 `virtual_offset` / `scale` / `user_instructions`。
3. **定位窗口**（关键，先做）：目标窗口往往**不是全屏**，屏幕其余部分是桌面
   图标/壁纸，会严重干扰 OCR 与点击。先拿到目标窗口的物理像素边界（见下），
   之后的截图/OCR/点击**全部只发生在该窗口矩形内**。
4. **分析窗口内**：用 picturereader 的 `image_scan` / `image_ocr` 只读窗口区域
   （先大块扫，再对命中的小块细分），得到目标元素的**虚拟屏坐标**。
5. **做**：`computer_click` / `computer_type` / `computer_keypress` /
   `computer_scroll` / `computer_drag` / `computer_move_mouse`，坐标填虚拟屏坐标。
   在 `virtual` 落点下这些动作会在面板上演示出来，用户看得见。
6. **验**：再 `computer_screenshot`（同一区域，建议带 `keep_overlays: true`），
   必要时 `image_compare` 对比前后；用户也能直接看着面板确认。
7. 等动画/加载用 `computer_wait`；看指针位置用 `computer_get_cursor_position`。

---

## 定位窗口（先定位窗口，才能避免背景干扰）

**为什么必须先定位窗口**：桌面图标/壁纸会以文字形式混入 OCR 结果（例如
「回收站」「此电脑」），让你把桌面上的元素误当成应用里的按钮，越点越偏。

Windows 下标准做法（命令行/PowerShell 均可，纯本地）：

1. 找到目标进程（如 `Get-Process -Name "*Deepseek Harness*"`），确定主窗口句柄。
2. **必须用 DPI 感知的 `GetWindowRect`** 拿物理像素边界：
   ```
   Add-Type 'public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
   [DpiAware]::SetProcessDPIAware() | Out-Null
   GetWindowRect(hwnd) → (left, top, right, bottom)   # 物理像素
   ```
   > 注意：**不调用 `SetProcessDPIAware()` 时拿到的是逻辑坐标**，在 150% 缩放
   > 的屏幕上会与截图/点击的物理像素不一致，把窗口定位到错误位置。
3. 把窗口矩形换算成屏幕比例，截图时就只截这个 region：
   `region = [(left - vx) / screenW, (top - vy) / screenH, (right - vx) / screenW, (bottom - vy) / screenH]`
   其中 `vx, vy` 是 `computer_screenshot` 返回的 `virtual_offset`，
   `screenW, screenH` 是虚拟屏尺寸（= 截图宽高 ÷ scale）。
4. 之后 OCR 得到的坐标是**窗口局部**的，加回 `(left, top)` 才是全局虚拟屏坐标。

---

## 关于落点与模式

| 设置 | 值 | 含义 |
|---|---|---|
| 动作落点 `link_mode` | `virtual`（默认） | 鼠标键盘只作用在右侧快照面板上，用户桌面不受影响 |
| | `real` | Win32 SendInput 真正操作本机，会占用用户真实光标 |
| 运行模式 `mode` | `disabled` | 全部拒绝 |
| | `readonly` | 仅 `computer_screenshot` / `computer_get_cursor_position` / `computer_get_vision` / `computer_wait` |
| | `manual`（默认） | 有副作用的工具需用户先输入 `/computer` 批准 |
| | `auto` | 全部工具自由调用 |

- 在 `virtual` 下点击/输入是**演示**，不会改变任何应用状态，因此「验证」这一步
  不要指望看到真实界面变化——要真效果，先让用户切到 `real`，或让用户在面板上
  确认。**不要为了「让动作生效」而自作主张切到 `real`**：那是用户的机器。
- `computer_set_mode` / `computer_set_link_mode` 只有在用户打开
  「AI 可自行修改运行模式」后才可用（默认关闭）。

---

## 怎么把话说清楚

- 你在 `virtual` 下做的一切，用户都在右侧面板上看得到。所以**说清你要做什么**，
  让用户有机会在你点错之前叫停。
- 用户可能在 `user_instructions` 里给你留坐标，也可能在对话里说「就点那个按钮」。
  优先用 `user_instructions` —— 那是像素级的答案。
- 截图 `age_ms` 超过几秒就别用了，重新截一张；界面可能已经变了。
