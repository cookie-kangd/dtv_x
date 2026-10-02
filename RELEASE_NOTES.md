# DTV_X v0.2.7 更新内容

本版修掉一个「关窗口到托盘之后资源全在后台空跑」的问题，同时补上一个真实的崩溃风险点。

> **点右上角 X 关到托盘后，再双击快捷方式会开出第二个 DTV_X。**

## 🚫 单实例互斥：同一个 exe 只允许跑一个进程

### 确认了：之前**根本没有**单实例机制

代码里有一行注释写着「This backend is single-instance」——但那只是**一句自我声明**，
项目里没有任何实现它的东西。该注释描述的是「业务上只处理一个房间」，
和「操作系统层面只允许一个进程」是两回事，被混为一谈了。

### 为什么关到托盘后才暴露

平时双击快捷方式时，第二次启动会开出第二个窗口，用户一眼就能看到。
但点X 关到托盘后，第一个进程**还活着**（这是设计如此），这时候再双击：
用户以为在「重新打开」，实际是**开出了第二个进程**。于是：

- 两套 WebView2 同时跑，内存直接翻倍
- 两套弹幕 WebSocket 同时连着同一个直播间
- 两个本地图片代理抢同一个固定端口（34721），第二个会 `AddrInUse`
- 托盘图标出现两个，退出时容易只关掉一个，另一个变成找不到窗口的残留进程

### 改法

引入官方插件 `tauri-plugin-single-instance`。它的机制是：

- 第一个实例正常启动，拿到一个系统级的命名互斥体（Windows 上是命名互斥体）
- 第二个实例启动时**不会走到 `run()`**，而是把命令行参数交给第一个实例后**立即退出**
- 所以不存在「第二个窗口」「第二套弹幕与代理」的可能，从根上避免

同时把唤起逻辑合并成一个 `show_main_window()`，三处共用（托盘左键、托盘菜单「显示」、
再次双击快捷方式）——这三处原本是三份重复代码，且都少了必要步骤：

```rust
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();      // 窗口可能被关到托盘隐藏了
        let _ = window.unminimize();// show 之后可能仍是最小化态
        let _ = window.set_focus();  // 显示出来不一定拿到焦点
        let _ = app.emit("main-window-shown", ());
    }
}
```

**现在双击快捷方式的正确行为是：把托盘里那个窗口叫回前台，而不是开一个新的。**

## 🛑 关窗口到托盘后，播放/弹幕/代理不再空跑

### 这是本版最大的实际收益

之前点 X 关到托盘，只是窗口被隐藏了，**该跑的东西一样没停**：

| 项目 | 状态 |
|---|---|
| `<video>` 解码 | 继续拉流、继续解码 |
| 5 个弹幕 WebSocket | 继续收发（斗鱼/虎牙/B站/抖音/Twitch） |
| actix 本地代理 | 继续转发 `/live.flv` |
| 卡死看门狗 | 3秒一次继续空转 |

也就是说**你以为关掉了，但它在后台继续吃流量和 CPU**。

### 为什么前端自己发现不了

前端原本只监听 `document.visibilityState`。但 **Tauri 的 `hide()` 只是隐藏窗口，
WebView2 页面仍是 active 状态，不保证触发 `visibilitychange`**。所以这条兜底形同虚设。

### 改法：由 Rust 显式发事件

在 `on_window_event` 的隐藏分支里 emit `main-window-hidden`，
前端收到后暂停视频、停掉全部弹幕后端与代理；唤起时 emit `main-window-shown` 恢复播放。

```ts
listen("main-window-hidden", () => {
  video.pause();
  void stopAllDanmakuBackends();
  void stopAllProxies();
});
```

**注意只「暂停」而不销毁播放器**：窗口可能只是临时切到托盘，保住会话能瞬间恢复播放，
不必重新取流（省一次请求，也避免重新取流失败后又黑屏）。

停弹幕/代理那两个函数本身就是并行 + 逐个 4 秒超时兜底的（v0.2.5 改过），
所以即使后端某个停止命令卡住，也不会拖住这条链路。

## 💥 修掉一个真实的 panic 风险

`fetch_douyu_room_info.rs` 里构造 Referer 请求头时：

```rust
// 改之前
HeaderValue::from_str(&format!("https://www.douyu.com/{}", room_id)).unwrap(),
```

`room_id` 来自前端 `invoke`，是**用户可控的任意字符串**。只要它含非 ASCII 字符或换行，
`HeaderValue::from_str` 就返回 `Err`，`unwrap()` 直接 panic——把「用户输入了一个非法房间号」
变成一个不可解释的失败。现已改为正常传播错误：

```rust
let referer = format!("https://www.douyu.com/{}", room_id);
let referer_value = HeaderValue::from_str(&referer)
    .map_err(|_| format!("房间号非法（不能含非 ASCII 字符或换行）：{}", room_id))?;
headers.insert("Referer", referer_value);
```

## 🧹 另外三处清理

**B站弹幕 uid 解析不再 panic**：`uid` 来自 Cookie 里的 `mid`，正常是数字，
但风控/异常响应时可能返回非数字。原来的 `parse().unwrap()` panic 虽被弹幕线程的
`catch_unwind` 兜住不至于崩应用，后果却是「B站弹幕静默失效 + 每 60 秒重试刷一次日志」——
极难排查。现已改为 `unwrap_or(0)`（项目里本来就有传 `"0"` 的先例）。

**统一退出路径**：更新器安装完成后原本直接 `app.exit(0)`，此时 `QUITTING` 仍是 `false`，
万一退出过程中触发窗口事件会误走「隐藏到托盘」分支。现在改为和托盘「退出」走同一个
`really_quit()`：置 `QUITTING` + 停全部后台任务 + 关所有窗口。

**退出时注销 mDNS**：`shutdown_background_tasks` 之前只停了弹幕和本地代理，
漏了局域网同步服务。结果是退出瞬间mDNS 还在对外广播「本机可同步」，
而服务其实已经没了，扫到的是个连不上的空壳。现在退出时显式 `unregister` + `shutdown`。

## 说明

- 从 **v0.2.6 可以直接应用内一键更新**
- 本版涉及窗口生命周期，如果你习惯「关到托盘后继续听声音」，请注意：
  现在关窗会**暂停播放并断开弹幕**，重新点开窗口会**自动恢复播放**
