// Twitch 播放辅助：取流（usher master m3u8 / 画质变体）。
//
// 注意：Twitch 的 playlist 边缘节点（*.playlist.ttvnw.net）会校验 Origin 头，
// 只放行 https://www.twitch.tv；而 WebView2 的跨域 XHR 必然带上
// Origin: http://tauri.localhost，且 Origin 属于 forbidden header（JS 改不了），
// 于是 hls.js 请求 m3u8 一律 403 → 黑屏转圈。因此这里把播放地址改写为本地
// HLS 代理（Rust 侧 reqwest 回源，不带 Origin），代理服务端还会把 m3u8 文本里的
// URL 继续改写成代理地址，形成完整链路。
import { invoke } from "@tauri-apps/api/core";

let proxyBasePromise: Promise<string | null> | null = null;

/** 启动（幂等）并获取本地代理 base，例如 http://127.0.0.1:34721 */
function ensureProxyBase(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!proxyBasePromise) {
    proxyBasePromise = invoke<string>("start_static_proxy_server")
      .then((base) => (base ? String(base).replace(/\/+$/, "") : null))
      .catch(() => null);
  }
  return proxyBasePromise;
}

function toProxyUrl(base: string | null, url: string): string {
  if (!base || !url) return url;
  return `${base}/hls?url=${encodeURIComponent(url)}`;
}

export interface TwitchStreamConfig {
  streamUrl: string;
  streamType: string;
  qualities: string[];
  title: string;
  anchorName: string;
  avatar: string;
  isLive: boolean;
}

interface TwitchStreamInfoResp {
  stream_url: string;
  stream_type: string;
  qualities: string[];
  selected_url: string;
  title: string;
  anchor_name: string;
  avatar: string;
  is_live: boolean;
}

function enforceHttps(url: string): string {
  if (!url) return url;
  return url.replace(/^http:\/\//i, "https://");
}

export async function getTwitchStreamConfig(login: string, quality?: string | null): Promise<TwitchStreamConfig> {
  const info = await invoke<TwitchStreamInfoResp>("get_twitch_stream_cmd", {
    login,
    quality: quality || null
  });
  const proxyBase = await ensureProxyBase();
  const streamUrl = toProxyUrl(proxyBase, enforceHttps(info.selected_url || info.stream_url));
  return {
    streamUrl,
    streamType: info.stream_type || "hls",
    qualities: Array.isArray(info.qualities) ? info.qualities : [],
    title: info.title || "",
    anchorName: info.anchor_name || login,
    avatar: info.avatar || "",
    isLive: !!info.is_live
  };
}

export function inferTwitchStreamType(url: string): string {
  const lower = (url || "").toLowerCase();
  if (lower.includes(".m3u8")) return "hls";
  if (lower.includes(".flv")) return "flv";
  return "hls";
}
