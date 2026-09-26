<div align="center">

# 📺 dtv_x

**轻量化直播聚合应用（exe）**

斗鱼 · 虎牙 · 抖音 · B站 —— 直播一站式观看，专注看直播

[![Release](https://img.shields.io/github/v/release/cookie-kangd/dtv_x?style=flat-square&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/cookie-kangd/dtv_x/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/cookie-kangd/dtv_x/windows-build.yml?style=flat-square&label=CI)](https://github.com/cookie-kangd/dtv_x/actions/workflows/windows-build.yml)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-brightgreen?style=flat-square)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=flat-square&logo=tauri)]()
[![License](https://img.shields.io/badge/License-%E5%AD%A6%E4%B9%A0%E4%BA%A4%E6%B5%81-lightgrey?style=flat-square)]()

[下载安装](#-下载安装) · [功能一览](#-功能一览) · [常见问题](#-常见问题) · [自行构建](#-自行构建)

轻量化安卓直播聚合应用(exe)：斗鱼、虎牙、抖音、B站 直播一站式观看，专注看直播。基于 [Tauri 2.0](https://tauri.app/) 构建，体积小、占用率低，实测双核 4GB 内存的电脑也能流畅运行。

</div>

> 上游项目：[chen-zeong/DTV](https://github.com/chen-zeong/DTV)　·　安卓版本：[dtv_mx](https://github.com/cookie-kangd/dtv_mx)

---

## 📥 下载安装

前往 [**Releases（最新版）**](https://github.com/cookie-kangd/dtv_x/releases/latest) 下载 `DTV_X_<版本>_x64-setup.exe`，双击安装即可。国内直连 GitHub 下载慢？用下面的加速镜像，把安装包链接前面拼上镜像前缀即可：

| 来源 | 链接前缀 |
|---|---|
| GitHub 直连 | 无 |
| Cloudflare | `https://gh-proxy.org/` |
| **Cloudflare (v4推荐)** ⭐ | `https://v4.gh-proxy.org/` |
| Cloudflare (v4/v6) | `https://v6.gh-proxy.org/` |
| Fastly (v4) | `https://cdn.gh-proxy.org/` |
| AxisNow (v4) | `https://axisnow.gh-proxy.org/` |

示例：`https://v4.gh-proxy.org/https://github.com/cookie-kangd/dtv_x/releases/download/v0.1.1/DTV_X_0.1.1_x64-setup.exe`

- **系统要求**：Windows 10/11 x64（Win7 需自行安装 Webview2）
- **覆盖安装**：直接运行新版安装包即可覆盖升级，收藏与设置均保留
- **应用内更新**：内置「检查更新」，发现新版本时下载链接已自动拼接加速镜像

---

## ✨ 功能一览

### 🎬 直播聚合
- **四大平台**：斗鱼 / 虎牙 / B站 / 抖音，一个应用全搞定
- **分区浏览**：各平台官方分区分类
- **搜索主播**：按平台搜索直播间
- **收藏排序**：收藏喜欢的主播，支持收藏列表手动拖拽排序

| 平台 | 直播流 | 弹幕 | 搜索 |
|---|---|---|---|
| 斗鱼 | ✅ | ✅ | ✅ |
| 虎牙 | ✅ | ✅ | ✅ |
| B站 | ✅ | ✅ | ✅ |
| 抖音 | ✅ | ✅ | 仅房间号 |

### 🎞 播放体验
- **低占用播放**：Tauri + 系统 WebView，体积小、内存占用低
- **画质档位**：按平台支持多画质切换
- **全屏播放**：播放器页面独立窗口布局，专注看直播

### 💬 弹幕
- **实时弹幕**：四平台 WebSocket 实时接收
- **纯净弹幕**：只显示聊天弹幕，不显示礼物等其他类型

### 🎨 外观
- **主题切换**：明暗主题一键切换

### 🧰 其它
- **数据同步**：局域网一键同步或 json 文件手动同步，可与桌面端/移动端互传
- **内置更新检查**：启动时检测 GitHub Release 新版本，下载链接自动走加速镜像

---

## ❓ 常见问题

<details>
<summary><b>提示缺少 HEVC(H.265) 解码插件？</b></summary>

Windows 系统未安装 HEVC 视频扩展所致。按应用内提示安装 `Microsoft.HEVCVideoExtension` 插件后重启软件即可。
</details>

<details>
<summary><b>搜索时频繁触发验证码？</b></summary>

平台接口有访问频率限制，过于频繁的请求会触发验证码校验，建议合理使用搜索功能。
</details>

<details>
<summary><b>某个平台的直播打不开了？</b></summary>

第三方接口变动所致，等版本更新适配。
</details>

<details>
<summary><b>收藏数据怎么迁移到另一台电脑？</b></summary>

用应用内的数据同步功能：两台设备在同一局域网时可一键同步，也可以导出 json 文件后在另一台电脑手动导入。
</details>

<details>
<summary><b>弹幕不显示了？</b></summary>

弹幕连接失败会自动重连。若长时间不恢复，多见于平台风控或网络环境限制，可尝试重新进入直播间。
</details>

---

## 🛠 自行构建

**环境要求**

- Node.js 20+
- pnpm 9
- Rust stable
- protobuf（Rust 构建依赖）

```bash
# 克隆项目
git clone https://github.com/cookie-kangd/dtv_x.git
cd dtv_x

# 安装依赖
pnpm install

# 开发调试
pnpm tauri dev

# 打包构建（当前系统安装包）
pnpm tauri build
```

---

## 🧱 技术栈

| 类别 | 选型 |
|---|---|
| 框架 | Tauri 2.0（Rust + 系统 WebView） |
| 前端 | Next.js、React、TypeScript |
| 异步 / 网络 | tokio、reqwest、tokio-tungstenite |
| 弹幕协议 | WebSocket（斗鱼 / 虎牙 / B站）+ protobuf（抖音） |
| JS 引擎 | deno_core（平台签名算法） |

---

## 📄 说明

- 本项目仅用于**学习与技术交流**，非任何平台官方产品，与抖音、哔哩哔哩、斗鱼、虎牙均无关联
- 播放内容来自第三方公开接口，**版权归属第三方**，请遵守各平台用户协议，**勿作商业用途**
- 本项目未进行任何逆向工程

---

## 🔍 关键词

直播聚合 · 直播聚合客户端 · 斗鱼直播 · 虎牙直播 · 抖音直播 · B站直播 · 哔哩哔哩直播 · 弹幕播放器 · Tauri · 桌面直播客户端 · 开源直播 App · 免广告直播客户端
