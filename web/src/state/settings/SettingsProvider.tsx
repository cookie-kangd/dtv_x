"use client";

// 全局应用设置（参考 dtv_mx 的设置面板）。
// localStorage 持久化：关闭应用再打开依然生效（key: dtv_app_settings_v1）。
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const SETTINGS_STORAGE_KEY = "dtv_app_settings_v1";

// 平台 id 与 Navbar/AppShell 的 UiPlatform 保持一致
export const ALL_PLATFORM_IDS = ["douyu", "huya", "douyin", "bilibili", "twitch"] as const;

export interface AppSettings {
  // ===== 基本设置 =====
  rememberCategory: boolean; // 记住每个平台最后选中的分类（默认开）
  danmuDefaultOn: boolean; // 未手动设置过弹幕时的默认弹幕开关（默认开）
  defaultQuality: string; // 未手动选过画质时的默认画质（默认原画）
  highRefreshRate: boolean; // 屏幕高刷：开=跟随系统最高刷新率；关=界面动画/弹幕锁定 60fps 省 GPU（默认开）
  clearCacheOnExit: boolean; // 退出时清理缓存：清理 WebView2 磁盘缓存等垃圾数据，登录态与设置保留（默认开）
  twitchZhOnly: boolean; // Twitch 推荐只看中文：关=全语言人气总榜（默认开）
  followPollIntervalMin: number; // 关注列表在线状态自动轮询间隔（分钟），0=关闭；默认 2 分钟
  // ===== 平台设置 =====
  enabledPlatforms: Record<string, boolean>; // 平台启用开关（缺省视为启用）
  platformOrder: string[]; // 平台在导航栏的显示顺序
}

export const DEFAULT_SETTINGS: AppSettings = {
  rememberCategory: true,
  danmuDefaultOn: true,
  defaultQuality: "原画",
  highRefreshRate: true,
  clearCacheOnExit: true,
  twitchZhOnly: true,
  followPollIntervalMin: 2,
  enabledPlatforms: {},
  platformOrder: [...ALL_PLATFORM_IDS]
};

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

type SettingsContextValue = {
  settings: AppSettings;
  hydrated: boolean;
  update: (patch: Partial<AppSettings>) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = loadJson<AppSettings>(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS);
    // platformOrder 兜底：新增平台自动排到末尾
    const order = Array.isArray(loaded.platformOrder)
      ? [...loaded.platformOrder.filter((p) => (ALL_PLATFORM_IDS as readonly string[]).includes(p)),
         ...ALL_PLATFORM_IDS.filter((p) => !loaded.platformOrder.includes(p))]
      : DEFAULT_SETTINGS.platformOrder;
    setSettings({ ...loaded, platformOrder: order });
    setHydrated(true);
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    // 更新函数必须是纯函数：React StrictMode 会双次调用它（生产环境亦应纯），
    // 原先在其中直接 saveJson / invoke 会造成重复写盘与重复 IPC。
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // 持久化：settings 任一字段变化即写盘。放在 effect 里、依赖真实状态，
  // 既保证纯函数语义，也天然做到「值没变就不写」。
  useEffect(() => {
    if (!hydrated) return;
    saveJson(SETTINGS_STORAGE_KEY, settings);
  }, [hydrated, settings]);

  // 把「退出时清理缓存」同步给 Rust（清理动作在应用退出时由 Rust 执行，
  // 该开关本身只存在前端 localStorage）。完成水合时同步一次，之后仅当该开关变化才发 IPC。
  useEffect(() => {
    if (!hydrated) return;
    invoke("set_exit_cleanup_enabled", { enabled: !!settings.clearCacheOnExit }).catch(() => {});
  }, [hydrated, settings.clearCacheOnExit]);

  const value = useMemo<SettingsContextValue>(() => ({ settings, hydrated, update }), [settings, hydrated, update]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useAppSettings must be used within SettingsProvider");
  return ctx;
}

/** 读取「是否记住栏目」开关（不依赖 Provider，供 HomePage 初始化时同步读取） */
export function readRememberCategoryEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return parsed.rememberCategory !== false;
  } catch {
    return true;
  }
}
