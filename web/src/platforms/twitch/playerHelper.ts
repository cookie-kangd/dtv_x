// Twitch 播放辅助：取流（usher master m3u8 / 画质变体）。
// Twitch CDN 支持 CORS，无需本地代理。
import { invoke } from "@tauri-apps/api/core";

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
  const streamUrl = enforceHttps(info.selected_url || info.stream_url);
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
