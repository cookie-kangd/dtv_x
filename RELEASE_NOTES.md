# DTV_X v0.1.5 更新内容

## 🔧 Twitch 参数全面对齐 dtv_mx（参数以 dtv_mx 实测为准）

本次将 Twitch 全部接口参数与 dtv_mx 项目逐项对齐，并用 dtv_mx 同款参数实测验证通过：

### 1. 语言过滤写法修正（推荐内容不对的根因）
- 语言过滤必须放进 `options` 对象：`streams(options: { languages: ["ZH"] })` 才真正生效
- 此前尝试的两种写法都有问题：平铺参数 `streams(languages:)` 会被服务端**静默忽略**；
  目录页 persisted query 有反爬限制（翻页触发 integrity check）、hash 也存在失效风险
- 实测：中文总榜 + 中文谈天说地（25 条）+ 中文 IRL（10 条），三路合并去重后 59 条中文频道

### 2. 「推荐」改为 dtv_mx 同款三路聚合
- 中文人气总榜 + 中文「谈天说地」+ 中文 IRL，三路并发拉取后**去重、按观众数重排**
- 内容量比单路翻倍以上，且天然带上中文观众最常看的谈天说地/IRL
- 保留 `node.language` 客户端兜底过滤（服务端偶有漏网，实测 59 条里混 2 条 EN，已过滤）

### 3. GQL 请求补上 Accept-Language: zh-CN
- 与 dtv_mx 一致：分类名/板块名返回网页版中文界面文案（Just Chatting → **谈天说地**）

### 4. 列表翻页策略修正
- 匿名 Client-ID 带 `after` 游标翻页会被服务端 integrity check 直接拒绝（dtv_mx 踩坑记录），
  且 `first` 上限为 30，此前传 40/100 的写法已被限制
- 现统一为「单页 30 条」，分类内列表默认全语言（与网页版分类页行为一致，避免空列表）

### 5. usher 播放参数对齐
- 播放凭据请求与 usher URL 参数与 dtv_mx 完全一致（六参数），移除此前的自创参数

## 📌 沿用 v0.1.4 的播放链路修复

- 本地 HLS 代理继续保留：Twitch playlist 边缘节点会 403 掉 WebView2 自带的
  `Origin: http://tauri.localhost`（浏览器禁止 JS 改写该头），播放请求统一经
  本机代理由 Rust 回源解决——这与参数无关，两者配合才能正常播放
