# DTV_X v0.2.2 更新内容

## 🟢🔴 关注/取关按钮看不清——这次找到真正的根因并彻底修掉

前两版把按钮改成了「绿=关注 / 红=取关」的实心胶囊，但按钮**始终只剩一圈空心描边、文字几乎看不见**。这次定位到真正的原因：

**全局按钮复位样式的优先级压过了组件样式。**

`legacy-global.css` 里有一条针对裸 `<button>` 的复位规则：

```css
button:not(.button):not([data-slot="button"]) { border: none; background: none; }
```

看起来只是给按钮"去掉默认边框和背景"，但 **`:not(.button)`、`:not([data-slot="button"])` 里的类选择器是会计入选择器特异性的**，这条规则的实际特异性高达 **(0,2,1)**，而组件里 `.searchFollowBtn` 只是单类选择器 **(0,1,0)**。所以无论 CSS 加载顺序如何，`background: none` 都会赢——按钮的绿/红底色被干掉，只剩下描边轮廓。

修复分三层，确保任何情况下都不会再被压掉：

1. **把全局规则的特异性降到 0**：改用 `:where(button:not(.button):not([data-slot="button"]))` 包裹，`:where()` 内部的选择器不再计入特异性，从此不会再压过任何组件样式
2. **按钮加内联样式兜底**：直接在元素上写 `backgroundColor` / `color`（内联样式优先级最高），即使将来再出现同类全局覆盖也不会失效
3. **样式表加 `!important`**：`.searchFollowBtn` 的背景/文字色用 `!important`，同时补上「已关注 + 悬停」的组合选择器，避免红色按钮在悬停时被绿色的 `:hover` 规则错误覆盖

> 顺带说明：这条全局规则影响的**不只是关注按钮**。字体弹窗的确认按钮、更新弹窗按钮、局域网同步弹窗的按钮（`.primaryBtn` / `.dangerBtn`）都用了实心背景，同样是被这条规则压掉的。第 1 项改动把它们一并救回来了。

## 🐛 其它修复

- **斗鱼刷新辅助函数（`followListHelper.ts`）判定逻辑与主流程对齐**：该文件里仍保留着旧版"要求 `video_loop === 0` 才算开播"的判断，并且在 `show_status === 1` 但 `video_loop` 取值异常时会错误地判为未开播、还会误标 `REPLAY` 状态，与关注列表主流程（`show_status === 1` 即开播）不一致。已统一为同一套判定规则，避免后续被误用
- **移除每次轮询都打印的调试日志**：斗鱼刷新路径里的 `console.log` 会在长时间运行后持续堆积控制台输出，已清理

## ⚡ WebView2 进一步优化

在主窗口与登录窗口的浏览器参数中追加了几项低风险、确定性收益的开关（两处参数已校验完全一致，避免创建第二个 webview 时报 0x8007139F）：

- **`--disable-features=...,CalculateNativeWinOcclusion`**：Edge 会周期性地用 `EnumWindows` 计算窗口遮挡状态，纯直播播放场景下没有收益却很吃 CPU，关闭可降低持续占用
- **`--enable-features=CanvasOopRasterization`**：把画布光栅化放到独立进程，弹幕大量绘制时主 UI 线程更少卡顿
- **`--renderer-process-limit=2`**：限制渲染进程数量上限，降低内存占用
- **`--js-flags=--max-old-space-size=512`**：限制 V8 老生代堆上限，避免长时间运行后内存持续膨胀

原有的「禁用后台节流」相关参数全部保留（`--disable-backgrounding-occluded-windows`、`--disable-background-timer-throttling`、`--disable-renderer-backgrounding`），确保窗口被遮挡时播放与轮询不受影响。

## 📦 安装包

- Windows x64 安装包：`DTV_X_0.2.2_x64-setup.exe`
