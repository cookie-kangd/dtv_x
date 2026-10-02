# DTV_X v0.2.6 更新内容

本版修掉一个从 v0.2.3 一直潜伏、靠手动刷新也救不回来的故障，并做了一轮资源占用清理。

> **关注列表的「自动刷新」失效了：状态永远不更新，点刷新也没反应。**

## 🐛 关注列表自动刷新：互斥锁被永久钉死

### 症状

- 到点了不刷新，直播中 / 已下播状态一直不变
- **手动点刷新按钮也没用**——这是最迷惑的地方，因为按钮明明有响应动画

### 根因

刷新函数 `refreshList` 开头有一行互斥判断：

```ts
if (isRefreshingRef.current) return;   // 正在刷新就跳过
```

这一行本身是对的（防止定时轮询和手动点击并发刷新）。问题出在**锁的释放只挂在 `finally` 上**：

```ts
isRefreshingRef.current = true;
try {
  await Promise.all(workers);   // ← 这里逐个 await invoke(...)
} finally {
  isRefreshingRef.current = false;
}
```

只要**任何一个**主播的 `invoke` 永不返回，这个 `await` 就永远不结束，`finally` 永远不执行，锁就永久停在 `true`。

从此以后：定时轮询每次进来都被第一行挡回去，手动刷新也被挡回去——**所有刷新路径同时失效**，而 UI 上没有任何提示。

### 为什么会卡死不返回

这是本版 Rust 侧修复的根因。项目里大部分 HTTP 请求都设了整体超时，但有 **10 处 `reqwest::Client::builder()` 只写了 `connect_timeout`、漏了 `.timeout()`**：

```rust
// 改之前
reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))   // 只管 TCP/TLS 握手
    .no_proxy()
    .build()
```

`connect_timeout` **只管连接建立阶段**。一旦连上了，响应体可以无限期挂住——弱网环境下对端「只收不发」（不返回数据也不断连）就能让这个请求永久占着。

### 本次改法：两层都堵上

**第一层 · Rust 侧补齐整体超时（10 处）**

所有漏掉的 client 补上 `.timeout(30s)`，覆盖 B站取流 / 列表 / 搜索 / wbi、斗鱼列表与分类、虎牙搜索与弹幕取参数：

```rust
reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(30))   // 新增：整体上限
    .no_proxy()
    .build()
```

其中 `bilibili/stream_url.rs` 这一处最关键——它是**每次重连都要调**的取流接口。原先每次重连都可能留下一个悬挂请求，切房间或反复重连后 socket 与内存会单调增长。

**第二层 · 前端超时兜底（不依赖后端）**

光靠后端不够：网络栈、代理、系统休眠都可能让 invoke 迟迟不回。所以前端也自己加了一层：

- 新增 `invokeWithTimeout()`，单个主播状态查询最多等 20 秒
- `refreshOne` 里 5 处 `invoke` 全部改用它
- `refreshList` 加**总闸定时器**：按本轮实际主播数推算上限（每个 20s ÷ 并发 2 + 15s 余量），到点强制释放锁
- `finally` 里补上卸载检查，组件已卸载就不再 setState

这样即使后端再出现新的挂死路径，**刷新功能也不会被彻底锁死**——最坏情况是这一轮状态没更新，下一轮照样能进。

## 🎨 资源占用清理

这一轮扫了全项目的 CSS 合成成本、定时器 / 监听器泄漏和后端常驻任务，处理了以下几项：

**光主题下关掉两处纯浪费的毛玻璃**

判据很简单：**背景 alpha ≥ 0.9（不透明）时，`backdrop-filter` 必然不可见**。

- `.navbar`：光主题下背景被覆盖成不透明的 `#f8fafc`，但仍挂着 `blur(28px) saturate(220%)`。而 navbar 是 `position: sticky`，**页面滚动时逐帧重算**——全站最贵的一处浪费
- `.syncBtnGlass.primaryBtn`：光主题下被不透明渐变盖住，模糊同样看不见

**去掉三处 `will-change: height`**

`height` 是 layout 属性，Chromium 无法把它提升为合成层动画。写 `will-change: height` 的效果是「提前触发重排」——**只有副作用，没有收益**，还白白创建常驻合成层。已改为 `will-change: transform, opacity`。

这三处是列表里**每一行都存在**的元素（跟随鼠标移动的高亮条），等于给 N 行常驻图层。

**`transition: all` 改为显式列出属性**

播放器控制条同时带 `backdrop-filter: blur(16px)`，而 `transition: all` 会把模糊也纳入过渡范围——鼠标每次进出 hover 都会触发一串高斯模糊重算。已改为只过渡 `background-color` 和 `border-color`。

## 🔍 顺带说明：确认无需修的项

这轮也排查了一批看着可疑但实际没问题的代码，列出来免得以后重复排查：

- **弹幕数组有 200 条硬上限**（抖音 / 虎牙 / B站）——不是无界增长
- **所有弹幕长连接都有停止信号 + 退避上限 30s**——退出时能正确打断
- **播放器卸载清理完整**（销毁播放器、停看门狗、停 5 个弹幕后端、停 2 个代理，全部带 4 秒超时）
- **`useEffect` 早退没有漏清理**——定时器创建都在 early return 之后
- **所有 `void invoke()` 都接了 catch**，无 unhandled rejection

## 说明

- 从 **v0.2.5 可以直接应用内一键更新**
- 本版没有改动任何播放 / 弹幕逻辑，只影响「关注列表状态刷新」与界面渲染开销
