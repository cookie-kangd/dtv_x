<div align="center">

# 📺 dtv_x

**轻量化直播聚合应用（exe）**

斗鱼 · 虎牙 · 抖音 · B站 —— 直播一站式观看，专注看直播

[![Release](https://img.shields.io/github/v/release/cookie-kangd/dtv_x?style=flat-square&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/cookie-kangd/dtv_x/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/cookie-kangd/dtv_x/windows-build.yml?style=flat-square&label=CI)](https://github.com/cookie-kangd/dtv_x/actions/workflows/windows-build.yml)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-brightgreen?style=flat-square)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=flat-square&logo=tauri)]()
[![License](https://img.shields.io/badge/License-%E5%AD%A6%E4%B9%A0%E4%BA%A4%E6%B5%81-lightgrey?style=flat-square)]()

[下载安装](#-下载安装) · [功能一览](#-功能一览) · [自行构建](#-自行构建)

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

示例：`https://v4.gh-proxy.org/https://github.com/cookie-kangd/dtv_x/releases/download/v0.1/DTV_X_0.1.0_x64-setup.exe`

- **系统要求**：Windows 10/11 x64（Win7 需自行安装 Webview2）
- **安装方式**：NSIS 安装包，下载后双击安装

---

## ✨ 功能一览

### 🎬 直播聚合
- **四大平台**：斗鱼 / 虎牙 / B站 / 抖音，一个应用全搞定
- **分区浏览**：各平台官方分区分类
- **搜索主播**：按平台搜索直播间

| 平台 | 直播流 | 弹幕 | 搜索 |
|---|---|---|---|
| 斗鱼 | ✅ | ✅ | ✅ |
| 虎牙 | ✅ | ✅ | ✅ |
| B站 | ✅ | ✅ | ✅ |
| 抖音 | ✅ | ✅ | 仅房间号 |

### 🎞 播放体验
- **弹幕显示**：实时显示直播间弹幕，只显示聊天弹幕，不显示礼物等其他类型
- **主播收藏**：收藏喜欢的主播，支持收藏列表手动拖拽排序
- **数据同步**：局域网一键同步或 json 文件手动同步，可与桌面端/移动端互传
- **主题切换**：明暗主题一键切换

### ⚠️ 使用说明
1. 平台接口可能有访问频率限制，过于频繁的请求会触发验证码校验，建议合理使用搜索功能
2. 本项目仅供学习编程目的使用，未进行任何逆向工程
3. 本项目所有的直播版权都归属各个平台

---

## 📷 软件截图

<div align="center">
  <p>日间模式</p>
  <img src="images/iShot_light.webp" alt="win-日间模式" style="width: 100%; max-width: 800px; display: block; margin-left: auto; margin-right: auto;">
</div>

<br>

<div align="center">
  <p>夜间模式</p>
  <img src="images/iShot_dark.webp" alt="mac-夜间模式" style="width: 100%; max-width: 800px; display: block; margin-left: auto; margin-right: auto;">
</div>

<br>

<div align="center">
  <p>日间模式 - 播放器页面</p>
  <img src="images/iShot_light2.webp" alt="日间模式播放器页面" style="width: 100%; max-width: 800px; display: block; margin-left: auto; margin-right: auto;">
</div>

---

## 🛠 自行构建

```bash
# 安装 protobuf（Rust 构建依赖）

# 克隆项目
git clone https://github.com/cookie-kangd/dtv_x.git
cd dtv_x

# 安装依赖（需 pnpm 9）
pnpm install

# 开发调试
pnpm tauri dev

# 打包构建（当前系统安装包）
pnpm tauri build
```

## 🙏 参考

- 斗鱼直播流获取参考了 [@wbt5/real-url](https://github.com/wbt5/real-url)
- 抖音弹幕参考了[@saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher)
- 虎牙参考了https://github.com/liuchuancong/pure_live https://github.com/ihmily/DouyinLiveRecorder
- b站弹幕参考了https://github.com/xfgryujk/blivedm

## 打赏

软件完全免费，如果这个项目对你有帮助，欢迎打赏支持：

<div align="center">
  <img src="images/wechat.jpg" alt="微信赞赏码" width="260">
</div>
