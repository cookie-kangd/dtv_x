"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

type ThemePreference = "light" | "dark" | "system";
type EffectiveTheme = "light" | "dark";

/**
 * 主题强调色配色（同步上游 v4.1.0「多套主题配色」的思路）。
 * 说明：上游每套主题自带明暗底色，与本项目独立的「亮色/暗色/跟随系统」模式耦合较深，
 * 整体移植会架空现有明暗切换。因此这里只移植强调色部分，底色与文字继续使用原有体系。
 * 默认 classic 不改变任何现有外观。
 */
export const PALETTE_IDS = ["classic", "lime", "cyan", "violet", "amber", "rose", "mono"] as const;
export type ColorPalette = (typeof PALETTE_IDS)[number];

export const PALETTE_OPTIONS: ReadonlyArray<{ id: ColorPalette; name: string; description: string }> = [
  { id: "classic", name: "默认 · 青柠绿", description: "沿用原有配色" },
  { id: "lime", name: "信号青柠", description: "高饱和黄绿，夜间更醒目" },
  { id: "cyan", name: "青蓝", description: "冷色系强调色" },
  { id: "violet", name: "紫罗兰", description: "柔和紫" },
  { id: "amber", name: "琥珀", description: "暖橙" },
  { id: "rose", name: "玫瑰", description: "暖红" },
  { id: "mono", name: "黑白灰", description: "无彩色极简" }
];

type ThemeContextValue = {
  userPreference: ThemePreference;
  effectiveTheme: EffectiveTheme;
  palette: ColorPalette;
  setPalette: (palette: ColorPalette) => void;
  setUserPreference: (pref: ThemePreference) => void;
  toggleLightDark: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORE_KEY = "theme_preference";
/** 与 layout.tsx 中的首帧内联脚本共用同一个 key，避免首帧闪白 / 配色闪烁。 */
export const PALETTE_STORE_KEY = "theme_palette";

function isPalette(value: unknown): value is ColorPalette {
  return typeof value === "string" && (PALETTE_IDS as readonly string[]).includes(value);
}

async function setTauriWindowTheme(theme: EffectiveTheme) {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const win = mod.WebviewWindow.getCurrent();
    await win.setTheme(theme);
  } catch {
    // 非 Tauri 环境无需处理
  }
}

function getSystemTheme(): EffectiveTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [userPreference, setUserPreferenceState] = useState<ThemePreference>("system");
  const [systemTheme, setSystemTheme] = useState<EffectiveTheme>("light");
  const [palette, setPaletteState] = useState<ColorPalette>("classic");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      setUserPreferenceState(stored);
    }
    const storedPalette = window.localStorage.getItem(PALETTE_STORE_KEY);
    if (isPalette(storedPalette)) {
      setPaletteState(storedPalette);
    }
    setSystemTheme(getSystemTheme());

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;

    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const effectiveTheme: EffectiveTheme = userPreference === "system" ? systemTheme : userPreference;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    void setTauriWindowTheme(effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-palette", palette);
  }, [palette]);

  const value = useMemo<ThemeContextValue>(() => {
    return {
      userPreference,
      effectiveTheme,
      palette,
      setPalette: (next) => {
        setPaletteState(next);
        try {
          window.localStorage.setItem(PALETTE_STORE_KEY, next);
        } catch {
          // ignore
        }
      },
      setUserPreference: (pref) => {
        setUserPreferenceState(pref);
        try {
          window.localStorage.setItem(STORE_KEY, pref);
        } catch {
          // ignore
        }
      },
      toggleLightDark: () => {
        const next = effectiveTheme === "light" ? "dark" : "light";
        setUserPreferenceState(next);
        try {
          window.localStorage.setItem(STORE_KEY, next);
        } catch {
          // ignore
        }
      }
    };
  }, [effectiveTheme, userPreference, palette]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
