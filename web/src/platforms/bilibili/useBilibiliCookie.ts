"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  bilibiliLoginWindowExists,
  closeBilibiliLoginWindow,
  ensureBilibiliCookieBootstrap,
  ensureBilibiliLoginWindow,
  extractRequiredFlags,
  getBilibiliCookies,
  hasRequiredCookies,
  sleep
} from "@/platforms/bilibili/cookieHelper";

const STORAGE_KEY = "bilibili_cookie";

function normalizeCookie(raw: string | null | undefined) {
  return String(raw ?? "").trim();
}

export type BilibiliCookieState = {
  cookie: string;
  hasRequired: boolean;
  isLoggingIn: boolean;
  error: string | null;
};

type Options = {
  autoBootstrap?: boolean;
  onChanged?: (cookie: string | null) => void;
};

export function useBilibiliCookie(options: Options = {}) {
  const { autoBootstrap = true, onChanged } = options;

  const [cookie, setCookie] = useState("");
  const [hasRequired, setHasRequired] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const onChangedRef = useRef<Options["onChanged"]>(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const updateFromRaw = useCallback((raw: string | null | undefined) => {
    const value = normalizeCookie(raw);
    const flags = extractRequiredFlags(value);
    if (!mountedRef.current) return;
    setCookie(value);
    setHasRequired(flags.hasSessdata && flags.hasBiliJct);
  }, []);

  const persist = useCallback(
    (raw: string | null | undefined) => {
      const value = normalizeCookie(raw);
      try {
        if (value) window.localStorage.setItem(STORAGE_KEY, value);
        else window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      updateFromRaw(value);
      try {
        onChangedRef.current?.(value ? value : null);
      } catch {
        // ignore
      }
    },
    [updateFromRaw]
  );

  const loadFromStorage = useCallback(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      updateFromRaw(saved);
    } catch {
      updateFromRaw(null);
    }
  }, [updateFromRaw]);

  const logout = useCallback(async () => {
    setError(null);
    persist(null);
  }, [persist]);

  const bootstrap = useCallback(async () => {
    if (!autoBootstrap) return;
    if (hasRequired) return;
    try {
      const result = await ensureBilibiliCookieBootstrap();
      if (result && hasRequiredCookies(result)) {
        persist(result.cookie);
      }
    } catch (e) {
      console.warn("[BilibiliCookie] Bootstrap failed:", e);
    }
  }, [autoBootstrap, hasRequired, persist]);

  useEffect(() => {
    mountedRef.current = true;
    loadFromStorage();
    void bootstrap();
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap, loadFromStorage]);

  const login = useCallback(async () => {
    if (isLoggingIn) return;
    setError(null);
    setIsLoggingIn(true);

    try {
      // 登录窗口由 Rust 侧创建（与主窗口 WebView2 参数一致，避免 0x8007139F）
      const { label } = await ensureBilibiliLoginWindow();

      const timeoutMs = 120_000;
      const intervalMs = 1_500;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const [result, windowExists] = await Promise.all([
          getBilibiliCookies([label]),
          bilibiliLoginWindowExists()
        ]);
        if (hasRequiredCookies(result)) {
          persist(result.cookie);
          await closeBilibiliLoginWindow();
          return;
        }
        if (!windowExists) {
          throw new Error("登录窗口已关闭，未完成登录");
        }
        await sleep(intervalMs);
      }

      throw new Error("登录超时，请重试");
    } catch (e: any) {
      const msg = e?.message || "登录失败，请重试";
      if (mountedRef.current) setError(msg);
      console.error("[BilibiliCookie] Login failed:", e);
    } finally {
      if (mountedRef.current) setIsLoggingIn(false);
    }
  }, [isLoggingIn, persist]);

  const state = useMemo<BilibiliCookieState>(() => {
    return { cookie, hasRequired, isLoggingIn, error };
  }, [cookie, error, hasRequired, isLoggingIn]);

  return {
    ...state,
    loadFromStorage,
    persist,
    bootstrap,
    login,
    logout
  };
}
