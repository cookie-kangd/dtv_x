"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

let sharedProxyBase = "";
let sharedEnsurePromise: Promise<string> | null = null;
const sharedSubscribers = new Set<() => void>();

function getSharedProxyBase() {
  return sharedProxyBase;
}

function setSharedProxyBase(nextBase: string) {
  const normalized = (nextBase || "").trim();
  if (normalized === sharedProxyBase) return;
  sharedProxyBase = normalized;
  for (const fn of sharedSubscribers) {
    try {
      fn();
    } catch {
      // ignore subscriber errors
    }
  }
}

/**
 * 丢弃当前缓存的 base，让下一次 ensureProxyStarted 重新向Rust 申请。
 *
 * 背景：Rust 侧静态代理的幂等判断已改为「本进程是否启动过它」，
 * 不再靠「端口能否连上」猜测（后者会把占用同端口的其它进程误认成我们的代理）。
 * 但如果这里仍持有一个坏base，早退逻辑就会一直复用它、永不重试。
 * 图片加载失败时调用它即可让整条链路重新自愈。
 */
export function invalidateSharedProxyBase() {
  sharedEnsurePromise = null;
  setSharedProxyBase("");
}

function subscribeSharedProxyBase(fn: () => void) {
  sharedSubscribers.add(fn);
  return () => {
    sharedSubscribers.delete(fn);
  };
}

export function useImageProxy() {
  const proxyBaseRef = useRef(getSharedProxyBase());
  const [proxyBaseState, setProxyBaseState] = useState(getSharedProxyBase());

  useEffect(() => {
    return subscribeSharedProxyBase(() => {
      const latest = getSharedProxyBase();
      proxyBaseRef.current = latest;
      setProxyBaseState(latest);
    });
  }, []);

  const ensureProxyStarted = useCallback(async () => {
    try {
      const current = getSharedProxyBase();
      // 只信任「看起来确实是本地代理 base」的值。
      // 万一拿到空串或明显异常的地址，宁可丢弃重试，也不要永久缓存一个坏 base
      // —— 那会让全站封面/头像永久加载失败且无法自愈。
      if (current && /^https?:\/\/127\.0\.0\.1:\d+\/?$/.test(current)) return;
      if (current) invalidateSharedProxyBase();
      if (!sharedEnsurePromise) {
        sharedEnsurePromise = invoke<string>("start_static_proxy_server")
          .then((base) => {
            setSharedProxyBase(base || "");
            return getSharedProxyBase();
          })
          .catch((e) => {
            sharedEnsurePromise = null;
            throw e;
          });
      }
      await sharedEnsurePromise;
    } catch (e) {
      console.warn("[useImageProxy] ensureProxyStarted failed:", e);
    }
  }, []);

  const proxify = useCallback((url: string | null | undefined) => {
    const trimmed = (url || "").trim();
    if (!trimmed) return "";
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        return trimmed;
      }
    } catch {
      // ignore invalid url
    }
    const baseRaw = proxyBaseRef.current;
    if (!baseRaw) return trimmed;
    const base = baseRaw.endsWith("/") ? baseRaw.slice(0, -1) : baseRaw;
    return `${base}/image?url=${encodeURIComponent(trimmed)}`;
  }, []);

  const proxyReady = useMemo(() => !!proxyBaseState, [proxyBaseState]);

  const getAvatarSrc = useCallback(
    (platform: string, avatarUrl?: string | null) => {
      const u = avatarUrl || "";
      if (!u) return "";
      const p = String(platform || "").toUpperCase();
      if (p === "BILIBILI" || p === "HUYA") {
        // Avoid switching src from direct url -> proxied url (causes flicker on re-renders).
        // For these platforms, only render avatar once proxy is ready.
        if (!proxyReady) return "";
        return proxify(u);
      }
      return u;
    },
    [proxify, proxyReady]
  );

  return { ensureProxyStarted, proxify, getAvatarSrc, proxyBaseRef, proxyReady };
}
