"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";
import { AnimatePresence, m } from "framer-motion";
import { POSITIONS } from "xgplayer/es/plugin/plugin.js";

import "xgplayer/dist/index.min.css";
import "./player.css";

import type { DanmakuMessage, DanmuOverlayInstance, RustGetStreamUrlPayload } from "@/components/player/types";
import type { DanmuKeywordBlockPreferences, DanmuUserSettings } from "@/components/player/constants";
import {
  applyDanmuFontFamilyForOS,
  DANMU_BLOCK_KEYWORDS_CHANGED_EVENT,
  ICONS,
  loadDanmuKeywordBlockPreferences,
  loadDanmuPreferences,
  loadStoredVolume,
  persistDanmuKeywordBlockPreferences,
  persistDanmuPreferences,
  sanitizeDanmuArea,
  sanitizeDanmuOpacity
} from "@/components/player/constants";
import { arrangeControlClusters } from "@/components/player/controlLayout";
import { Platform } from "@/platforms/common/types";
import { getDouyuStreamConfig, stopDouyuProxy } from "@/platforms/douyu/playerHelper";
import { getHuyaStreamConfig, stopHuyaProxy } from "@/platforms/huya/playerHelper";
import { fetchAndPrepareDouyinStreamConfig } from "@/platforms/douyin/playerHelper";
import { getBilibiliStreamConfig } from "@/platforms/bilibili/playerHelper";
import { getTwitchStreamConfig } from "@/platforms/twitch/playerHelper";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useFollow, type FollowedStreamer, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { usePlayerUi } from "@/state/playerUi/PlayerUiProvider";
import { useAppSettings } from "@/state/settings/SettingsProvider";

declare global {
  // Used to guard against React StrictMode(dev) mount/unmount cycles accidentally stopping a newer player session.
  // eslint-disable-next-line no-var
  var __DTV_PLAYER_MOUNT_GEN: number | undefined;
}

const qualityOptions = ["原画", "高清", "标清"] as const;

// ===== 直播自动重连策略 =====
// 分两层：
//   1) 播放器内核自愈（flv.disconnectRetryCount / hls.retryCount）——负责秒级短抖动，用户无感知；
//   2) 应用层重连（本组常量）——内核放弃后接管。必须「重新获取流地址」而不是重试旧 URL，
//      因为斗鱼/虎牙/B站的播放地址带时效 token，断线几十秒后旧地址基本已失效。
const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY_MS = 1000; // 退避基数：1s,2s,4s,8s,16s,20s(封顶)
const RECONNECT_MAX_DELAY_MS = 20000;
// 卡死看门狗：直播中 currentTime 长时间不推进，判定为「假死」
// （内核没抛 error、但画面停住——弱网/丢包时很常见，必须靠主动检测兜底）
const STALL_CHECK_INTERVAL_MS = 3000;
const STALL_STUCK_MS = 12000;

const PLAYER_DRAG_EXCLUDED_SELECTOR = [
  // App chrome / topbar (主播信息栏 & 关闭/关注按钮等)
  ".player-topbar",
  ".player-window-controls",
  // Stream error overlay (中间刷新按钮)
  ".retry-btn",
  // Generic interactive elements
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[contenteditable='true']",
  // xgplayer controls / popups (播放器控制栏及其菜单)
  ".xgplayer-controls",
  ".xgplayer-controls *",
  ".xgplayer-danmu-block-panel",
  ".xgplayer-danmu-settings-panel",
  ".xgplayer-quality-dropdown",
  ".xgplayer-line-dropdown"
].join(", ");

const DEFAULT_DANMU_SETTINGS: DanmuUserSettings = {
  color: "#ffffff",
  strokeColor: "#444444",
  fontSize: "20px",
  duration: 10000,
  area: 0.5,
  mode: "scroll",
  opacity: 1
};

function resolveStoredQuality(platform: Platform) {
  try {
    const saved = window.localStorage.getItem(`${platform}_preferred_quality`);
    if (saved && ((qualityOptions as readonly string[]).includes(saved) || platform === Platform.TWITCH)) return saved;
  } catch {
    // ignore
  }
  return "原画";
}

function isOfflineMessage(msg: string) {
  const s = (msg || "").toLowerCase();
  return s.includes("未开播") || s.includes("主播未开播") || s.includes("房间不存在");
}

function supportsMseType(mime: string) {
  try {
    return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

function maybeAppendHevcInstallHint(rawMessage: string) {
  const msg = String(rawMessage || "");
  const lower = msg.toLowerCase();
  const looksLikeHevcCodecUnsupported =
    (lower.includes("video/mp4") && (lower.includes("hev1") || lower.includes("hvc1"))) ||
    lower.includes("hevc") ||
    lower.includes("h.265") ||
    lower.includes("h265");
  if (!looksLikeHevcCodecUnsupported) return msg;

  const hev1 = 'video/mp4; codecs="hev1.1.6.L93.B0"';
  const hvc1 = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
  const hev1Supported = supportsMseType(hev1);
  const hvc1Supported = supportsMseType(hvc1);

  if (!hev1Supported && !hvc1Supported) {
    return `${msg}\n\n提示：检测到当前环境不支持 HEVC(H.265) 解码（hev1/hvc1 均不支持）。\n请安装 Microsoft.HEVCVideoExtension 插件后重启软件。\n下载地址：https://github.com/cookie-kangd/dtv_x/releases\n（按 release 提示下载并安装对应插件）`;
  }

  return msg;
}

type UnifiedRustDanmakuPayload = {
  room_id?: string;
  user: string;
  content: string;
  user_level: number;
  fans_club_level: number;
  color?: string | null;
};

const DOUYU_COLORS: Record<number, string> = {
  // 斗鱼官方计算色值。
  1: '#FFFFFF', // 蓝/白
  2: '#70C150', // 绿
  3: '#E04AC0', // 粉
  4: '#D4A113', // 黄
  5: '#8A5BE9', // 紫
  6: '#FF314E', // 红
  7: '#FF314E', // 渐变色在覆盖层中降级为红色
};

function douyuColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return DOUYU_COLORS[parseInt(color, 10)];
}

type LineOption = { key: string; label: string };
const lineOptionsByPlatform: Partial<Record<Platform, LineOption[]>> = {
  [Platform.DOUYU]: [
    { key: "ws-h5", label: "主线路" },
    { key: "tct-h5", label: "线路5" },
    { key: "ali-h5", label: "线路6" },
    { key: "hs-h5", label: "线路13" }
  ],
  [Platform.HUYA]: [
    { key: "tx", label: "腾讯线路" },
    { key: "al", label: "阿里线路" },
    { key: "hs", label: "字节线路" }
  ]
};

function resolveStoredLine(platform: Platform, options: LineOption[]) {
  if (!options.length) return null;
  try {
    const saved = window.localStorage.getItem(`${platform}_preferred_line`);
    if (saved && options.some((o) => o.key === saved)) return saved;
  } catch {
    // ignore
  }
  return options[0]?.key ?? null;
}

function persistLinePreference(platform: Platform, lineKey: string) {
  try {
    window.localStorage.setItem(`${platform}_preferred_line`, lineKey);
  } catch {
    // ignore
  }
}

function resolveCurrentLineFor(options: LineOption[], currentLine: string | null) {
  if (!options.length) return null;
  if (currentLine && options.some((o) => o.key === currentLine)) return currentLine;
  return options[0]?.key ?? null;
}

export function MainPlayer({
  platform,
  roomId,
  onRequestCloseAction
}: {
  platform: Platform;
  roomId: string;
  onRequestCloseAction?: () => void;
}) {
  const router = useRouter();
  const follow = useFollow();
  const { setIsland, clearIsland, setFullscreen } = usePlayerUi();
  const appSettings = useAppSettings();

  // 全局默认画质（设置 → 基本设置）：仅在用户未手动选过画质时生效
  useEffect(() => {
    if (!appSettings.hydrated) return;
    try {
      if (!window.localStorage.getItem(`${platform}_preferred_quality`)) {
        setCurrentQuality(appSettings.settings.defaultQuality);
      }
    } catch {
      // ignore
    }
  }, [appSettings.hydrated, appSettings.settings.defaultQuality, platform]);

  // 全局默认弹幕开关：仅当用户从未手动设置过弹幕偏好时生效
  useEffect(() => {
    if (!appSettings.hydrated) return;
    if (appSettings.settings.danmuDefaultOn) return;
    if (loadDanmuPreferences()) return; // 用户已有持久化偏好，不覆盖
    setIsDanmuEnabled(false);
  }, [appSettings.hydrated, appSettings.settings.danmuDefaultOn]);
  const { ensureProxyStarted, getAvatarSrc } = useImageProxy();
  const pageRef = useRef<HTMLDivElement | null>(null);
  const dragStartArmedRef = useRef(false);
  const dragCandidateRef = useRef<null | { pointerId: number; x: number; y: number }>(null);

  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const playbackKindRef = useRef<null | "hls" | "flv">(null);
  const danmuOverlayRef = useRef<DanmuOverlayInstance | null>(null);
  const unlistenRef = useRef<null | (() => void)>(null);

  const disposedRef = useRef(false);
  const activeSessionIdRef = useRef(0);
  const sessionSeqRef = useRef(0);
  const mountGenRef = useRef(0);

  const refreshPluginRef = useRef<any>(null);
  const volumePluginRef = useRef<any>(null);
  const danmuTogglePluginRef = useRef<any>(null);
  const danmuSettingsPluginRef = useRef<any>(null);
  const danmuKeywordBlockPluginRef = useRef<any>(null);
  const qualityPluginRef = useRef<any>(null);
  const linePluginRef = useRef<any>(null);
  const hevcBrandPatchedRef = useRef(false);

  const [isLoadingStream, setIsLoadingStream] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isOfflineError, setIsOfflineError] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);

  // ===== 自动重连运行时状态（全部用 ref，避免定时器闭包读到陈旧值）=====
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  // 一旦确认「主播未开播 / 房间不存在」就置位，阻断自动重连（否则会对着下播的房间空转）；
  // 成功播放或用户手动重载时解除。注意：网络中断**不**置位，必须继续重连。
  const reconnectBlockedRef = useRef(false);
  const stallWatchdogRef = useRef<number | null>(null);
  const lastProgressRef = useRef<{ time: number; at: number }>({ time: -1, at: 0 });
  // 看门狗需要读取最新业务状态，用一个 ref 镜像，避免把它塞进 effect 依赖导致定时器反复重建
  const watchdogCtxRef = useRef<{ loading: boolean; offline: boolean; hasError: boolean; live: boolean | null }>({
    loading: false,
    offline: false,
    hasError: false,
    live: null
  });

  const [playerTitle, setPlayerTitle] = useState<string | null>(null);
  const [playerAnchorName, setPlayerAnchorName] = useState<string | null>(null);
  const [playerAvatar, setPlayerAvatar] = useState<string | null>(null);
  const [playerIsLive, setPlayerIsLive] = useState<boolean | null>(null);
  const [isWindows, setIsWindows] = useState(false);

  // 把最新播放状态镜像给卡死看门狗：看门狗跑在定时器里、不在渲染周期内，读不到最新 state。
  // 这里赋值是幂等的、不触发渲染，StrictMode 双渲染也安全。
  watchdogCtxRef.current = {
    loading: isLoadingStream,
    offline: isOfflineError,
    hasError: !!streamError,
    live: playerIsLive
  };
  const [isMaximized, setIsMaximized] = useState(false);

  const lineOptions: LineOption[] = useMemo(() => lineOptionsByPlatform[platform] ?? [], [platform]);
  const [currentQuality, setCurrentQuality] = useState<string>(() =>
    typeof window === "undefined" ? "原画" : resolveStoredQuality(platform)
  );
  // Twitch 画质列表是动态的（原画/720P60/480P/仅音频...），由取流结果填充；
  // 其他平台仍用静态 qualityOptions
  const [qualityOptionsOverride, setQualityOptionsOverride] = useState<string[] | null>(null);
  const effectiveQualityOptions = useMemo(
    () => (qualityOptionsOverride && qualityOptionsOverride.length > 0 ? qualityOptionsOverride : [...qualityOptions]),
    [qualityOptionsOverride]
  );
  const [currentLine, setCurrentLine] = useState<string | null>(() =>
    typeof window === "undefined" ? null : resolveStoredLine(platform, lineOptionsByPlatform[platform] ?? [])
  );
  const currentQualityRef = useRef(currentQuality);
  const currentLineRef = useRef(currentLine);
  const lineOptionsRef = useRef<LineOption[]>(lineOptions);
  currentQualityRef.current = currentQuality;
  currentLineRef.current = currentLine;
  lineOptionsRef.current = lineOptions;

  const [isDanmuEnabled, setIsDanmuEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = loadDanmuPreferences();
    return stored?.enabled ?? true;
  });
  const [danmuSettings, setDanmuSettings] = useState<DanmuUserSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_DANMU_SETTINGS;
    const stored = loadDanmuPreferences();
    return stored?.settings ?? DEFAULT_DANMU_SETTINGS;
  });
  const [danmuKeywordBlock, setDanmuKeywordBlock] = useState<DanmuKeywordBlockPreferences>(() => {
    if (typeof window === "undefined") return { enabled: true, keywords: [] };
    const loaded = loadDanmuKeywordBlockPreferences();
    return loaded ? { enabled: true, keywords: loaded.keywords } : { enabled: true, keywords: [] };
  });
  const danmuKeywordBlockPrefsRef = useRef<DanmuKeywordBlockPreferences>(danmuKeywordBlock);
  useEffect(() => {
    danmuKeywordBlockPrefsRef.current = danmuKeywordBlock;
  }, [danmuKeywordBlock]);

  const danmuKeywordBlockRef = useRef<{ keywordsLower: string[] }>({ keywordsLower: [] });
  useEffect(() => {
    danmuKeywordBlockRef.current = {
      keywordsLower: (danmuKeywordBlock.keywords ?? []).map((k) => String(k || "").trim().toLowerCase()).filter(Boolean)
    };
  }, [danmuKeywordBlock.keywords]);

  // 说明：此前版本在页面隐藏时自动暂停播放，但被其它应用遮挡/切换窗口时会
  // 误触发停播，影响"挂直播听声"的体验，已按用户要求移除。
  // 窗口遮挡导致的渲染降级由 WebView2 启动参数
  // --disable-backgrounding-occluded-windows 兜底（见 tauri.conf.json）。

  useEffect(() => {
    const keywordsEqual = (left: string[], right: string[]) => {
      if (left === right) return true;
      if (left.length !== right.length) return false;
      for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return false;
      }
      return true;
    };

    const onKeywordsChanged = () => {
      const next = loadDanmuKeywordBlockPreferences();
      const nextKeywords = next?.keywords ?? [];
      setDanmuKeywordBlock((prev) => {
        const prevKeywords = prev.keywords ?? [];
        if (keywordsEqual(prevKeywords, nextKeywords)) {
          return prev;
        }
        return { enabled: true, keywords: nextKeywords };
      });
    };

    window.addEventListener(DANMU_BLOCK_KEYWORDS_CHANGED_EVENT, onKeywordsChanged as EventListener);
    return () => window.removeEventListener(DANMU_BLOCK_KEYWORDS_CHANGED_EVENT, onKeywordsChanged as EventListener);
  }, []);

  const [chromeVisible, setChromeVisible] = useState(true);
  const hideChromeTimerRef = useRef<number | null>(null);
  const moveRafRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const osMod: any = await import("@tauri-apps/plugin-os");
        const p = typeof osMod?.platform === "function" ? await osMod.platform() : "";
        if (cancelled) return;
        const platform = String(p).toLowerCase();
        setIsWindows(platform === "windows" || platform === "linux");
      } catch {
        // non-tauri env: ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isWindows) return;
    let cancelled = false;
    let unlisten: null | (() => void) = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        try {
          const max = await win.isMaximized();
          if (!cancelled) setIsMaximized(!!max);
        } catch {
          // ignore
        }
        try {
          unlisten = await win.onResized(async () => {
            try {
              const max = await win.isMaximized();
              setIsMaximized(!!max);
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, [isWindows]);

  const minimizeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {
      // ignore
    }
  }, []);

  const toggleMaximizeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const max = await win.isMaximized();
      if (max) await win.unmaximize();
      else await win.maximize();
      setIsMaximized(!max);
    } catch {
      // ignore
    }
  }, []);

  const closeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      // ignore
    }
  }, []);

  const startWindowDragging = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch {
      // ignore
    }
  }, []);

  const isDragExcludedTarget = useCallback((target: HTMLElement) => {
    return !!target.closest(PLAYER_DRAG_EXCLUDED_SELECTOR);
  }, []);

  const onPlayerPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const root = pageRef.current;
      if (!root || !root.contains(target)) return;
      if (isDragExcludedTarget(target)) return;

      // Defer dragging until the pointer moves a bit, so normal "click-to-toggle" behaviors still work.
      dragCandidateRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    },
    [isDragExcludedTarget]
  );

  const onPlayerPointerMoveCapture = useCallback(
    (e: React.PointerEvent) => {
      const candidate = dragCandidateRef.current;
      if (!candidate) return;
      if (candidate.pointerId !== e.pointerId) return;
      if (dragStartArmedRef.current) return;

      const dx = e.clientX - candidate.x;
      const dy = e.clientY - candidate.y;
      if (dx * dx + dy * dy < 36) return; // 6px threshold

      const target = e.target as HTMLElement | null;
      const root = pageRef.current;
      if (!target || !root || !root.contains(target)) {
        dragCandidateRef.current = null;
        return;
      }

      if (isDragExcludedTarget(target)) {
        dragCandidateRef.current = null;
        return;
      }

      dragStartArmedRef.current = true;
      dragCandidateRef.current = null;
      e.preventDefault();

      void startWindowDragging().finally(() => {
        window.setTimeout(() => {
          dragStartArmedRef.current = false;
        }, 300);
      });
    },
    [isDragExcludedTarget, startWindowDragging]
  );

  const onPlayerPointerUpCapture = useCallback((e: React.PointerEvent) => {
    const candidate = dragCandidateRef.current;
    if (!candidate) return;
    if (candidate.pointerId !== e.pointerId) return;
    dragCandidateRef.current = null;
  }, []);

  useEffect(() => {
    const armHide = () => {
      if (hideChromeTimerRef.current) window.clearTimeout(hideChromeTimerRef.current);
      hideChromeTimerRef.current = window.setTimeout(() => {
        try {
          const root = pageRef.current;
          const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
          const hasOpenMenu = !!root?.querySelector?.(
            ".xgplayer-danmu-block.menu-open, .xgplayer-danmu-settings.menu-open, .xgplayer-quality-control.menu-open, .xgplayer-line-control.menu-open"
          );
          const isEditingInPopup =
            !!active &&
            !!root &&
            root.contains(active) &&
            !!active.closest?.(
              ".xgplayer-danmu-block-panel, .xgplayer-danmu-settings-panel, .xgplayer-quality-dropdown, .xgplayer-line-dropdown"
            );

          if (hasOpenMenu || isEditingInPopup) {
            setChromeVisible(true);
            armHide();
            return;
          }
        } catch {
          // ignore
        }
        setChromeVisible(false);
      }, 8000);
    };

    // Start hidden-after-idle behavior immediately on mount.
    setChromeVisible(true);
    armHide();

    const onMove = () => {
      if (moveRafRef.current) return;
      moveRafRef.current = window.requestAnimationFrame(() => {
        moveRafRef.current = 0;
        setChromeVisible(true);
        armHide();
      });
    };

    // Listen on `window` to avoid WebView/video layers swallowing pointer events.
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove as any);
      window.removeEventListener("pointermove", onMove as any);
      if (hideChromeTimerRef.current) window.clearTimeout(hideChromeTimerRef.current);
      if (moveRafRef.current) window.cancelAnimationFrame(moveRafRef.current);
      hideChromeTimerRef.current = null;
      moveRafRef.current = 0;
    };
  }, []);

  const chromeHiddenClass = chromeVisible ? "" : " player-chrome-hidden";

  const reloadStreamRef = useRef<
    | null
    | ((
        trigger: "refresh" | "quality" | "line",
        overrides?: { quality?: string; line?: string | null },
        opts?: { isAutoReconnect?: boolean }
      ) => Promise<void>)
  >(null);
  const qualityReloadArmedRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const pendingReloadRef = useRef<null | {
    trigger: "refresh" | "quality" | "line";
    overrides?: { quality?: string; line?: string | null };
    opts?: { isAutoReconnect?: boolean };
  }>(null);

  const isSessionActive = useCallback((sessionId: number) => {
    return !disposedRef.current && activeSessionIdRef.current === sessionId;
  }, []);

  // ===== 直播自动重连（应用层）=====
  // 分工：播放器内核负责秒级抖动自愈（flv.disconnectRetryCount / hls.retryCount），
  // 内核放弃后、或画面「假死」，由这里接管：指数退避 + 重新取流。

  const clearReconnectTimers = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (stallWatchdogRef.current !== null) {
      window.clearInterval(stallWatchdogRef.current);
      stallWatchdogRef.current = null;
    }
    lastProgressRef.current = { time: -1, at: 0 };
  }, []);

  /** 画面真正恢复播放后调用：重置退避计数、解除阻断、清掉重连提示。 */
  const markReconnectHealthy = useCallback(() => {
    reconnectAttemptRef.current = 0;
    reconnectBlockedRef.current = false;
    setReconnectNotice(null);
  }, []);

  /**
   * 触发一次自动重连（指数退避 1s→2s→4s→8s→16s→20s）。
   * 关键：重连走 reloadStream("refresh") 重新取流，而不是重试旧 URL——
   * 斗鱼/虎牙/B站的播放地址都带时效 token，断线几十秒后旧地址通常已经失效，
   * 单纯重试旧地址正是「内核重试耗尽后就再也连不上」的另一半原因。
   */
  const scheduleReconnect = useCallback((reason: string) => {
    if (disposedRef.current) return;
    // 已确认「主播未开播 / 房间不存在」→ 不再对着下播的房间空转重连。
    // 注意这里刻意不用 isOfflineError：取流失败（可能是网络问题）也会把它置 true，
    // 若用它做闸门，网络一断就再也连不回来了。
    if (reconnectBlockedRef.current) return;
    if (reconnectTimerRef.current !== null) return; // 已有待执行的重连，避免叠加
    if (reloadInFlightRef.current) return; // 正在取流，等它结束再说

    const attempt = reconnectAttemptRef.current;
    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      setReconnectNotice(null);
      setStreamError(
        `网络连接中断，已自动重连 ${RECONNECT_MAX_ATTEMPTS} 次仍未成功。\n请检查网络连接后点击「再试一次」。`
      );
      return;
    }

    reconnectAttemptRef.current = attempt + 1;
    const seq = attempt + 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
    console.info(`[Player] 连接中断（${reason}），${delay}ms 后进行第 ${seq}/${RECONNECT_MAX_ATTEMPTS} 次自动重连`);
    setReconnectNotice(
      delay >= 1000
        ? `连接中断，${Math.round(delay / 1000)} 秒后自动重连（第 ${seq}/${RECONNECT_MAX_ATTEMPTS} 次）…`
        : `连接中断，正在自动重连（第 ${seq}/${RECONNECT_MAX_ATTEMPTS} 次）…`
    );

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (disposedRef.current) return;
      setReconnectNotice(`正在重连（第 ${seq}/${RECONNECT_MAX_ATTEMPTS} 次）…`);
      void reloadStreamRef.current?.("refresh", undefined, { isAutoReconnect: true });
    }, delay);
  }, []);

  /**
   * 卡死看门狗：每 3 秒检查 currentTime 是否推进。
   * 兜住「播放器没抛 error、但画面其实停住了」的假死场景——弱网丢包时很常见，
   * 只监听 error 事件会漏掉这一类。
   */
  const startStallWatchdog = useCallback(() => {
    if (stallWatchdogRef.current !== null) return;
    lastProgressRef.current = { time: -1, at: 0 };
    stallWatchdogRef.current = window.setInterval(() => {
      if (disposedRef.current) return;
      const ctx = watchdogCtxRef.current;
      // 加载中 / 已报错 / 主播未开播：不判定，避免误伤
      if (ctx.loading || ctx.hasError || ctx.offline) return;

      let video: HTMLVideoElement | null = null;
      try {
        const root = playerRef.current?.root as HTMLElement | null;
        video = (root?.querySelector("video") as HTMLVideoElement) ?? null;
      } catch {
        video = null;
      }
      // 用户主动暂停、已播完：不算卡死
      if (!video || video.paused || video.ended) return;

      const now = Date.now();
      const prev = lastProgressRef.current;
      if (video.currentTime !== prev.time) {
        lastProgressRef.current = { time: video.currentTime, at: now };
        // 画面确实在推进 = 真的在播。这里主动重置退避状态，
        // 比只依赖播放器事件名更可靠（事件名可能随版本变化）。
        if (reconnectAttemptRef.current > 0 || reconnectBlockedRef.current) {
          markReconnectHealthy();
        }
        return;
      }
      const stuckSince = prev.at || now;
      if (now - stuckSince >= STALL_STUCK_MS) {
        lastProgressRef.current = { time: video.currentTime, at: now };
        scheduleReconnect("画面卡住");
      }
    }, STALL_CHECK_INTERVAL_MS);
  }, [markReconnectHealthy, scheduleReconnect]);

  useEffect(() => {
    if (platform === Platform.BILIBILI || platform === Platform.HUYA) {
      void ensureProxyStarted();
    }
  }, [ensureProxyStarted, platform]);

  useEffect(() => {
    setIsland({
      platform,
      roomId,
      anchorName: playerAnchorName,
      title: playerTitle,
      avatarUrl: getAvatarSrc(platform, playerAvatar)
    });
    return () => clearIsland();
  }, [clearIsland, getAvatarSrc, platform, playerAvatar, playerAnchorName, playerTitle, roomId, setIsland]);

  useEffect(() => {
    setFullscreen(isFullScreen);
    return () => setFullscreen(false);
  }, [isFullScreen, setFullscreen]);

  const isFollowed = useMemo(() => {
    const fp: FollowPlatform =
      platform === Platform.DOUYU
        ? "DOUYU"
        : platform === Platform.DOUYIN
          ? "DOUYIN"
          : platform === Platform.HUYA
            ? "HUYA"
            : platform === Platform.TWITCH
              ? "TWITCH"
              : "BILIBILI";
    return follow.isFollowed(fp, roomId);
  }, [follow, platform, roomId]);

  // 切回前台时若视频意外暂停则自动恢复（后台节流已由 Rust 侧禁用，这里是兜底）
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      try {
        const video = (playerRef.current as any)?.video as HTMLVideoElement | undefined;
        if (video && video.paused && !video.ended && video.readyState > 0) {
          void video.play().catch(() => {});
        }
      } catch {
        // ignore
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const destroyPlayer = useCallback(() => {
    // 切房间/切画质/销毁时，停掉挂起的自动重连定时器与卡死看门狗，
    // 避免旧会话的定时器在新会话里误触发一次重连。
    // 注意：这里刻意不重置 reconnectAttemptRef —— 自动重连内部也会经过 destroyPlayer，
    // 若在此清零，退避计数永远归零，会退化成无限重连。
    clearReconnectTimers();

    try {
      unlistenRef.current?.();
    } catch {
      // ignore
    }
    unlistenRef.current = null;

    try {
      danmuOverlayRef.current?.clear?.();
      danmuOverlayRef.current?.stop?.();
    } catch {
      // ignore
    }
    danmuOverlayRef.current = null;

    // 释放解码器 / MSE 缓冲：先清空 video 源再销毁播放器，避免连续切换房间时
    // 上一个流的数据残留在内存里（长时间浏览会持续涨内存）。
    try {
      const root = playerRef.current?.root as HTMLElement | null;
      const video = root?.querySelector("video") as HTMLVideoElement | null;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    } catch {
      // ignore
    }

    try {
      playerRef.current?.destroy();
    } catch {
      // ignore
    }
    playerRef.current = null;
    playbackKindRef.current = null;

    refreshPluginRef.current = null;
    volumePluginRef.current = null;
    danmuTogglePluginRef.current = null;
    danmuSettingsPluginRef.current = null;
    qualityPluginRef.current = null;
    linePluginRef.current = null;

    setIsFullScreen(false);
  }, [clearReconnectTimers]);

  const stopAllDanmakuBackends = useCallback(async () => {
    // Business rule: only one room at a time. Stopping all backends is the safest way to avoid cross-platform leaks.
    try {
      await invoke("stop_danmaku_listener", { roomId: "" });
    } catch {
      // ignore
    }
    try {
      await invoke("stop_douyin_danmu_listener");
    } catch {
      // ignore
    }
    try {
      await invoke("stop_huya_danmaku_listener", { roomId: "" });
    } catch {
      // ignore
    }
    try {
      await invoke("stop_bilibili_danmaku_listener");
    } catch {
      // ignore
    }
    try {
      await invoke("stop_twitch_danmaku_listener", { roomId: "" });
    } catch {
      // ignore
    }
  }, []);

  const stopAllProxies = useCallback(async () => {
    // Only one room at a time; stop both to avoid "switch platform" leaks.
    try {
      await stopDouyuProxy();
    } catch {
      // ignore
    }
    try {
      await stopHuyaProxy();
    } catch {
      // ignore
    }
  }, []);

  const startDanmaku = useCallback(
    async (
      sessionId: number,
      overlay: DanmuOverlayInstance | null,
      platformToStart: Platform,
      roomIdToStart: string,
      roomIdToFilter?: string
    ) => {
      try {
        unlistenRef.current?.();
      } catch {
        // ignore
      }
      unlistenRef.current = null;

       if (!roomIdToStart) return;
       if (!isSessionActive(sessionId)) return;

       try {
         try {
           overlay?.clear?.();
         } catch {
           // ignore
         }
         // Always stop existing backends first (cross-platform), then start the current one.
         await stopAllDanmakuBackends();
         if (!isSessionActive(sessionId)) return;

         if (platformToStart === Platform.DOUYU) {
           await invoke("start_danmaku_listener", { roomId: roomIdToStart });
         } else if (platformToStart === Platform.DOUYIN) {
           const payload: RustGetStreamUrlPayload = { args: { room_id_str: roomIdToStart }, platform: Platform.DOUYIN };
           await invoke("start_douyin_danmu_listener", { payload });
         } else if (platformToStart === Platform.HUYA) {
           await invoke("start_huya_danmaku_listener", { payload: { args: { room_id_str: roomIdToStart } } });
        } else if (platformToStart === Platform.BILIBILI) {
          const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") : null;
          await invoke("start_bilibili_danmaku_listener", {
            payload: { args: { room_id_str: roomIdToStart } },
            cookie: cookie || null
          });
        } else if (platformToStart === Platform.TWITCH) {
          await invoke("start_twitch_danmaku_listener", { payload: { args: { room_id_str: roomIdToStart } } });
        }
       } catch (e) {
         console.warn("[Player] start danmaku backend failed:", e);
         return;
       }

       const effectiveFilterRoomId = roomIdToFilter || roomIdToStart;
       const unlisten = await listen<UnifiedRustDanmakuPayload>("danmaku-message", (event: TauriEvent<UnifiedRustDanmakuPayload>) => {
        if (!isSessionActive(sessionId)) return;
        const p = event.payload;
        if (!p) return;
        if (p.room_id && p.room_id !== effectiveFilterRoomId) return;

         const msg: DanmakuMessage = {
           id: uuidv4(),
           nickname: p.user || "未知用户",
           content: p.content || "",
           level: String(p.user_level || 0),
           badgeLevel: p.fans_club_level > 0 ? String(p.fans_club_level) : undefined,
           room_id: p.room_id || effectiveFilterRoomId,
           // Twitch 弹幕颜色是 hex（#1E90FF），斗鱼是数字色号 → 分别处理
           color: p.color && p.color.startsWith("#") ? p.color : douyuColor(p.color)
         };

        const contentLower = (msg.content || "").toLowerCase();
        const block = danmuKeywordBlockRef.current;
        if (block.keywordsLower.length > 0) {
          for (const kw of block.keywordsLower) {
            if (kw && contentLower.includes(kw)) {
              return;
            }
          }
        }

        if (isDanmuEnabled && overlay?.sendComment) {
          try {
            overlay.sendComment({
              id: msg.id,
              txt: msg.content,
              duration: 12000,
              mode: "scroll",
              style: {
                color: msg.color || "#FFFFFF"
              }
            });
          } catch {
            // ignore
          }
        }
      });

      unlistenRef.current = unlisten;
    },
    [isDanmuEnabled, isSessionActive, stopAllDanmakuBackends]
  );

  const mountPlayer = useCallback(
    async (
      sessionId: number,
      url: string,
      streamType: string | undefined,
      danmakuBackendRoomIdOverride?: string | null,
      danmakuFilterRoomIdOverride?: string | null
    ) => {
      if (!isSessionActive(sessionId)) return;
      // 等待 DOM 渲染完成，确保 ref 可用
      let attempts = 0;
      while (!playerContainerRef.current && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 50));
        attempts++;
      }

      if (!playerContainerRef.current) {
        console.error("[Player] Player container ref is not available after waiting");
        throw new Error("播放器容器初始化失败，请刷新页面重试。");
      }
      if (!isSessionActive(sessionId)) return;

      const isHlsPlayback = (streamType || "").toLowerCase() === "hls" || url.toLowerCase().includes(".m3u8");

      const [{ default: PlayerCtor }, flvMod, hlsMod, overlayMod, pluginsMod] = await Promise.all([
        import("xgplayer"),
        import("xgplayer-flv"),
        import("xgplayer-hls.js"),
        import("@/components/player/danmuOverlay"),
        import("@/components/player/plugins")
      ]);

      const FlvPlugin: any = (flvMod as any).default ?? flvMod;
      const HlsPlugin: any = (hlsMod as any).default ?? hlsMod;
      const { applyDanmuOverlayPreferences, createDanmuOverlay, syncDanmuEnabledState } = overlayMod as any;
      const { DanmuKeywordBlockControl, DanmuSettingsControl, DanmuToggleControl, LineControl, QualityControl, RefreshControl, VolumeControl } =
        pluginsMod as any;

      const playerOptions: any = {
        el: playerContainerRef.current,
        url,
        autoplay: true,
        isLive: true,
        playsinline: true,
        lang: "zh-cn",
        videoFillMode: "contain",
        closeVideoClick: true,
        closeVideoTouch: true,
        keyShortcut: true,
        width: "100%",
        height: "100%",
        volume: false as unknown as number,
        pip: {
          position: POSITIONS.CONTROLS_RIGHT,
          index: 3,
          showIcon: true
        },
        cssFullscreen: {
          index: 2
        },
        playbackRate: false,
        controls: {
          mode: "normal"
        },
        icons: {
          play: ICONS.play,
          pause: ICONS.pause,
          fullscreen: ICONS.maximize2,
          exitFullscreen: ICONS.minimize2,
          cssFullscreen: ICONS.fullscreen,
          exitCssFullscreen: ICONS.minimize2,
          pipIcon: ICONS.pictureInPicture2,
          pipIconExit: ICONS.pictureInPicture2
        }
      };

      if (isHlsPlayback) {
        // Referer/Origin 伪装头仅对 B 站 CDN 生效。
        // Twitch 的 playlist 边缘节点会对带第三方 Origin 的请求返回 403，
        // 导致 hls.js 无限重试（黑屏一直加载、弹幕正常），因此按 URL 判定。
        const isBiliSource = /(^|\.)bilibili/i.test(url || "");
        const hlsFetchOptions: RequestInit = isBiliSource
          ? {
              referrer: "https://live.bilibili.com/",
              referrerPolicy: "no-referrer-when-downgrade",
              credentials: "omit",
              mode: "cors"
            }
          : {
              credentials: "omit",
              mode: "cors"
            };

        playerOptions.plugins = [HlsPlugin];
        playerOptions.useHlsPlugin = true;
        playerOptions.hls = {
          isLive: true,
          // 弱网容忍：默认 3 次 / 1000ms 对直播偏紧，抖一下就放弃。
          // 提高到 5 次 / 1500ms，配合应用层自动重连形成两级兜底。
          retryCount: 5,
          retryDelay: 1500,
          enableWorker: true,
          withCredentials: false,
          lowLatencyMode: false,
          // ===== 内存 / CPU / GPU 优化 =====
          // 说明：不使用 capLevelToPlayerSize —— 它会把自动画质压到播放器像素尺寸
          // 以下（例如 1100px 宽的播放区只给 480p），明显牺牲画质，得不偿失。
          // 正向缓冲目标：默认 30s 偏大，直播无需那么多余量，降到 12s。
          maxBufferLength: 12,
          maxMaxBufferLength: 24,
          // 缓冲区字节上限：默认 60MB，压到 20MB 控制内存峰值。
          maxBufferSize: 20 * 1000 * 1000,
          // 回看缓冲（已播放部分保留时长）：长时间挂机时控制内存增长。
          backBufferLength: 20,
          fetchOptions: hlsFetchOptions,
          xhrSetup: (xhr: XMLHttpRequest, reqUrl?: string) => {
            try {
              xhr.withCredentials = false;
              const target = reqUrl || url || "";
              if (/(^|\.)bilibili/i.test(target)) {
                xhr.setRequestHeader("Referer", "https://live.bilibili.com/");
                xhr.setRequestHeader("Origin", "https://live.bilibili.com");
              }
            } catch {
              // ignore
            }
          }
        };
      } else {
        // 弱网/兼容性兜底：部分 WebView2 环境对 `hev1` codec 字符串不支持，但对 `hvc1` 支持。
        // xgplayer-transmuxer 默认会生成 `hev1.*`，这里在运行时探测后做一次 monkey patch。
        const hev1 = 'video/mp4; codecs="hev1.1.6.L93.B0"';
        const hvc1 = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
        if (!hevcBrandPatchedRef.current && !supportsMseType(hev1) && supportsMseType(hvc1)) {
          try {
            const mod: any = await import("xgplayer-transmuxer/es/codec/hevc.js");
            const HEVC: any = mod?.HEVC;
            const orig = HEVC?.parseHEVCDecoderConfigurationRecord;
            if (HEVC && typeof orig === "function") {
              HEVC.parseHEVCDecoderConfigurationRecord = function (data: any, hvcC?: any) {
                const ret = orig.call(this, data, hvcC);
                if (ret && typeof ret.codec === "string" && ret.codec.startsWith("hev1")) {
                  ret.codec = `hvc1${ret.codec.slice(4)}`;
                }
                return ret;
              };
              hevcBrandPatchedRef.current = true;
              console.info("[Player] Patched HEVC codec brand: hev1 -> hvc1 (MSE compatibility).");
            }
          } catch (e) {
            console.warn("[Player] Failed to patch HEVC codec brand:", e);
          }
        }

        playerOptions.plugins = [FlvPlugin];
        playerOptions.flv = {
          isLive: true,
          cors: true,
          autoCleanupSourceBuffer: true,
          enableWorker: true,
          stashInitialSize: 128,
          lazyLoad: true,
          lazyLoadMaxDuration: 30,
          deferLoadAfterSourceOpen: true,
          // ===== 弱网 / 断流重连（关键修复）=====
          // xgplayer-flv 的 disconnectRetryCount 默认是 0 —— 也就是「直播流一旦断开就再也不重试」，
          // 这正是网络瞬断几十毫秒就导致直播直接中断、必须手动点刷新的根本原因。
          // 这里给一个较大的自愈窗口：内核静默重拉，用户几乎无感（不闪加载层、不重建播放器）。
          // 超出该窗口后，由应用层的自动重连（reloadStream + 指数退避）接手。
          retryCount: 3, // HTTP 请求失败重试次数（默认 3，显式声明）
          retryDelay: 1000, // 请求失败重试间隔（默认 1000ms）
          disconnectRetryCount: 10, // ★断流重试次数（默认 0 = 不重试）
          loadTimeout: 10000, // 请求超时（默认 10000ms）
          maxReaderInterval: 5000 // 连续多少毫秒收不到数据判定为断流（默认 5000ms）
        };
      }

      const player = new (PlayerCtor as any)(playerOptions);
      playerRef.current = player;
      if (!isSessionActive(sessionId)) {
        try {
          player.destroy?.();
        } catch {
          // ignore
        }
        playerRef.current = null;
        return;
      }
      playbackKindRef.current = isHlsPlayback ? "hls" : "flv";

      try {
        const storedPlayerVolume = loadStoredVolume();
        if (storedPlayerVolume !== null) {
          player.volume = storedPlayerVolume;
          player.muted = storedPlayerVolume === 0 ? true : player.muted;
        }
      } catch {
        // ignore
      }

      try {
        const onFull = (value: boolean) => setIsFullScreen(!!value);
        const onCssFull = (value: boolean) => setIsFullScreen(!!value || !!player.fullscreen);
        player.on?.("fullscreen_change", onFull);
        player.on?.("cssFullscreen_change", onCssFull);
        player.on?.("destroy", () => setIsFullScreen(false));
      } catch {
        // ignore
      }

      // ===== 自动重连：错误监听 =====
      // 内核重试耗尽后不会自己恢复，必须由应用层接手 —— 这正是「网络瞬断后直播直接中断、
      // 只能手动点刷新」的原因（旧代码只监听了全屏/destroy 事件，完全没监听 error）。
      try {
        player.on?.("error", (err: any) => {
          if (!isSessionActive(sessionId)) return;
          const detail = (err && (err.errorType || err.type || err.errorCode || err.message)) || "unknown";
          console.warn("[Player] 播放错误事件，准备自动重连:", err);
          // 延后一拍再调度：若此刻恰好处于 reloadStream 的 in-flight 窗口，
          // scheduleReconnect 的守卫会把这次调用丢掉，白白错过一次重连机会。
          window.setTimeout(() => {
            if (!isSessionActive(sessionId)) return;
            scheduleReconnect(String(detail));
          }, 0);
        });
        // 画面真正恢复播放 → 重置退避计数并清掉提示
        player.on?.("playing", () => {
          if (!isSessionActive(sessionId)) return;
          markReconnectHealthy();
        });
      } catch {
        // ignore
      }

      // 启动卡死看门狗：兜住「不抛 error、但画面停住」的假死场景
      startStallWatchdog();

      refreshPluginRef.current = player.registerPlugin?.(RefreshControl, {
        position: POSITIONS.CONTROLS_LEFT,
        index: 2,
        onClick: () => void reloadStreamRef.current?.("refresh")
      });

      volumePluginRef.current = player.registerPlugin?.(VolumeControl, {
        position: POSITIONS.CONTROLS_LEFT,
        index: 3
      });

      danmuTogglePluginRef.current = player.registerPlugin?.(DanmuToggleControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4,
        getState: () => isDanmuEnabled,
        onToggle: (enabled: boolean) => setIsDanmuEnabled(enabled)
      });

      danmuSettingsPluginRef.current = player.registerPlugin?.(DanmuSettingsControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4.2,
        getSettings: () => danmuSettings,
        onChange: (partial: Partial<DanmuUserSettings>) => {
          setDanmuSettings((prev) => {
            const next: DanmuUserSettings = { ...prev, ...partial };
            next.area = sanitizeDanmuArea(next.area);
            next.opacity = sanitizeDanmuOpacity(next.opacity);
            if (typeof next.strokeColor !== "string") next.strokeColor = "#444444";
            return next;
          });
        }
      });

      danmuKeywordBlockPluginRef.current = player.registerPlugin?.(DanmuKeywordBlockControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4.4,
        getPreferences: () => danmuKeywordBlockPrefsRef.current,
        onChange: (next: DanmuKeywordBlockPreferences) => setDanmuKeywordBlock({ enabled: true, keywords: next.keywords ?? [] })
      });

      qualityPluginRef.current = player.registerPlugin?.(QualityControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 5,
        options: [...effectiveQualityOptions],
        getCurrent: () => currentQualityRef.current,
        onSelect: (value: string) => {
          if (value === currentQualityRef.current) return;
          setCurrentQuality(value);
          try {
            window.localStorage.setItem(`${platform}_preferred_quality`, value);
          } catch {
            // ignore
          }
        }
      });

      linePluginRef.current = player.registerPlugin?.(LineControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 5.2,
        options: [...lineOptions],
        getCurrentKey: () => resolveCurrentLineFor(lineOptionsRef.current, currentLineRef.current) ?? "",
        getCurrentLabel: () => {
          const key = resolveCurrentLineFor(lineOptionsRef.current, currentLineRef.current);
          return lineOptionsRef.current.find((o) => o.key === key)?.label ?? "线路";
        },
        onSelect: (lineKey: string) => {
          if (lineKey === currentLineRef.current) return;
          setCurrentLine(lineKey);
          persistLinePreference(platform, lineKey);
        }
      });

      arrangeControlClusters(player);

      // danmu overlay
      const overlay = createDanmuOverlay(player, danmuSettings, isDanmuEnabled) as DanmuOverlayInstance | null;
      danmuOverlayRef.current = overlay;
      try {
        applyDanmuOverlayPreferences?.(overlay, danmuSettings, isDanmuEnabled, player.root as any);
        syncDanmuEnabledState(overlay, danmuSettings, isDanmuEnabled, player.root as any);
      } catch {
        // ignore
      }

      const backendRoomId = danmakuBackendRoomIdOverride || roomId;
      const filterRoomId = danmakuFilterRoomIdOverride || backendRoomId;
      await startDanmaku(sessionId, overlay, platform, backendRoomId, filterRoomId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      currentLine,
      currentQuality,
      danmuSettings,
      isDanmuEnabled,
      isSessionActive,
      lineOptions,
      platform,
      roomId,
      startDanmaku,
      // 以下三个均为稳定引用（useCallback 空依赖/单依赖），加入不会造成 mountPlayer 频繁重建
      scheduleReconnect,
      markReconnectHealthy,
      startStallWatchdog
    ]
  );

  const reloadStream = useCallback(
    async (
      _trigger: "refresh" | "quality" | "line",
      overrides?: { quality?: string; line?: string | null },
      opts?: { isAutoReconnect?: boolean }
    ) => {
      if (reloadInFlightRef.current) {
        pendingReloadRef.current = { trigger: _trigger, overrides, opts };
        return;
      }
      reloadInFlightRef.current = true;
      const sessionId = ++sessionSeqRef.current;
      activeSessionIdRef.current = sessionId;

      // 非自动重连（切房间/切画质/用户点刷新）视为「重新开始」：重置退避计数、解除阻断、清掉提示；
      // 自动重连必须保留计数，否则永远到不了上限、会无限重试拖垮自己和服务器。
      if (!opts?.isAutoReconnect) {
        reconnectAttemptRef.current = 0;
        reconnectBlockedRef.current = false;
        setReconnectNotice(null);
      }

      setIsLoadingStream(true);
      setStreamError(null);
      setIsOfflineError(false);
      setPlayerIsLive(null);
      setPlayerTitle(null);
      setPlayerAnchorName(null);
      setPlayerAvatar(null);

      const effectiveQuality = overrides?.quality ?? currentQuality;
      const effectiveLine = typeof overrides?.line !== "undefined" ? overrides.line : currentLine;

      // 每次重载先清掉动态画质列表（Twitch 分支会按取流结果重新填充）
      setQualityOptionsOverride(null);

      await stopAllDanmakuBackends();
      await stopAllProxies();
      if (!isSessionActive(sessionId)) return;

      try {
        await applyDanmuFontFamilyForOS();
      } catch {
        // ignore
      }

      // 取流失败且判定为「网络中断」时，不能立刻调用 scheduleReconnect ——
      // 那一刻 reloadInFlightRef 还是 true（函数开头置位、finally 才复位），
      // 会被 scheduleReconnect 的 in-flight 守卫直接挡掉，导致重连永远不触发。
      // 因此先记下原因，等 finally 复位后再调度。
      let pendingReconnectReason: string | null = null;

      try {
        if (platform === Platform.DOUYU) {
          const resolvedLine = resolveCurrentLineFor(lineOptions, effectiveLine);
          try {
            const info = await invoke<any>("fetch_douyu_room_info", { roomId });
            setPlayerTitle(info?.room_name ?? null);
            setPlayerAnchorName(info?.nickname ?? null);
            setPlayerAvatar(info?.avatar_url ?? null);
          } catch {
            // ignore meta fetch failures
          }
          const { streamUrl, streamType } = await getDouyuStreamConfig(roomId, effectiveQuality, resolvedLine);
          if (!isSessionActive(sessionId)) return;
          setPlayerIsLive(true);
          const nextIsHls = (streamType || "").toLowerCase() === "hls" || streamUrl.toLowerCase().includes(".m3u8");
          const nextKind: "hls" | "flv" = nextIsHls ? "hls" : "flv";
          const player = playerRef.current;
          const canSoftSwitch =
            !!player &&
            !!danmuOverlayRef.current &&
            typeof player.switchURL === "function" &&
            !!playbackKindRef.current &&
            playbackKindRef.current === nextKind;
          if (canSoftSwitch) {
            try {
              const ret = player.switchURL(streamUrl, { seamless: false });
              if (ret && typeof (ret as any).then === "function") await ret;
              if (isSessionActive(sessionId)) {
                playbackKindRef.current = nextKind;
                await startDanmaku(sessionId, danmuOverlayRef.current, platform, roomId);
              }
            } catch {
              destroyPlayer();
              await mountPlayer(sessionId, streamUrl, streamType);
            }
          } else {
            destroyPlayer();
            await mountPlayer(sessionId, streamUrl, streamType);
          }
        } else if (platform === Platform.DOUYIN) {
          const resp = await fetchAndPrepareDouyinStreamConfig(roomId, effectiveQuality);
          if (!isSessionActive(sessionId)) return;
          setPlayerTitle(resp.title ?? null);
          setPlayerAnchorName(resp.anchorName ?? null);
          setPlayerAvatar(resp.avatar ?? null);
          setPlayerIsLive(resp.isLive);
          if (!resp.streamUrl) throw new Error(resp.initialError || "主播未开播或无法获取直播流");
          // Douyin backend expects web_rid/live_id to bootstrap cookies, but emitted danmaku payload uses real room_id.
          const danmakuBackendRoomId = resp.webRid || roomId;
          const danmakuFilterRoomId = resp.normalizedRoomId || roomId;
          const nextIsHls = (resp.streamType || "").toLowerCase() === "hls" || resp.streamUrl.toLowerCase().includes(".m3u8");
          const nextKind: "hls" | "flv" = nextIsHls ? "hls" : "flv";
          const player = playerRef.current;
          const canSoftSwitch =
            !!player &&
            !!danmuOverlayRef.current &&
            typeof player.switchURL === "function" &&
            !!playbackKindRef.current &&
            playbackKindRef.current === nextKind;
          if (canSoftSwitch) {
            try {
              const ret = player.switchURL(resp.streamUrl, { seamless: false });
              if (ret && typeof (ret as any).then === "function") await ret;
              if (isSessionActive(sessionId)) {
                playbackKindRef.current = nextKind;
                await startDanmaku(sessionId, danmuOverlayRef.current, platform, danmakuBackendRoomId, danmakuFilterRoomId);
              }
            } catch {
              destroyPlayer();
              await mountPlayer(sessionId, resp.streamUrl, resp.streamType, danmakuBackendRoomId, danmakuFilterRoomId);
            }
          } else {
            destroyPlayer();
            await mountPlayer(sessionId, resp.streamUrl, resp.streamType, danmakuBackendRoomId, danmakuFilterRoomId);
          }
        } else if (platform === Platform.HUYA) {
          const resolvedLine = resolveCurrentLineFor(lineOptions, effectiveLine);
          const { streamUrl, streamType, title, anchorName, avatar, isLive } = await getHuyaStreamConfig(
            roomId,
            effectiveQuality,
            resolvedLine
          );
          if (!isSessionActive(sessionId)) return;
          setPlayerTitle(title ?? null);
          setPlayerAnchorName(anchorName ?? null);
          setPlayerAvatar(avatar ?? null);
          setPlayerIsLive(typeof isLive === "boolean" ? isLive : true);
          const nextIsHls = (streamType || "").toLowerCase() === "hls" || streamUrl.toLowerCase().includes(".m3u8");
          const nextKind: "hls" | "flv" = nextIsHls ? "hls" : "flv";
          const player = playerRef.current;
          const canSoftSwitch =
            !!player &&
            !!danmuOverlayRef.current &&
            typeof player.switchURL === "function" &&
            !!playbackKindRef.current &&
            playbackKindRef.current === nextKind;
          if (canSoftSwitch) {
            try {
              const ret = player.switchURL(streamUrl, { seamless: false });
              if (ret && typeof (ret as any).then === "function") await ret;
              if (isSessionActive(sessionId)) {
                playbackKindRef.current = nextKind;
                await startDanmaku(sessionId, danmuOverlayRef.current, platform, roomId);
              }
            } catch {
              destroyPlayer();
              await mountPlayer(sessionId, streamUrl, streamType);
            }
          } else {
            destroyPlayer();
            await mountPlayer(sessionId, streamUrl, streamType);
          }
        } else if (platform === Platform.BILIBILI) {
          const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") : null;
          try {
            const payload = { platform, args: { room_id_str: roomId } };
            const info = await invoke<any>("fetch_bilibili_streamer_info", { payload, cookie: cookie || null });
            setPlayerTitle(info?.title ?? null);
            setPlayerAnchorName(info?.anchor_name ?? null);
            setPlayerAvatar(info?.avatar ?? null);
          } catch {
            // ignore meta fetch failures
          }
          const { streamUrl, streamType } = await getBilibiliStreamConfig(roomId, effectiveQuality, cookie || undefined);
          if (!isSessionActive(sessionId)) return;
          setPlayerIsLive(true);
          const nextIsHls = (streamType || "").toLowerCase() === "hls" || streamUrl.toLowerCase().includes(".m3u8");
          const nextKind: "hls" | "flv" = nextIsHls ? "hls" : "flv";
          const player = playerRef.current;
          const canSoftSwitch =
            !!player &&
            !!danmuOverlayRef.current &&
            typeof player.switchURL === "function" &&
            !!playbackKindRef.current &&
            playbackKindRef.current === nextKind;
          if (canSoftSwitch) {
            try {
              const ret = player.switchURL(streamUrl, { seamless: false });
              if (ret && typeof (ret as any).then === "function") await ret;
              if (isSessionActive(sessionId)) {
                playbackKindRef.current = nextKind;
                await startDanmaku(sessionId, danmuOverlayRef.current, platform, roomId);
              }
            } catch {
              destroyPlayer();
              await mountPlayer(sessionId, streamUrl, streamType);
            }
          } else {
            destroyPlayer();
            await mountPlayer(sessionId, streamUrl, streamType);
          }
        } else if (platform === Platform.TWITCH) {
          // Twitch：roomId 即频道 login；GQL 元数据 + usher m3u8 一次拿全
          const cfg = await getTwitchStreamConfig(roomId, effectiveQuality);
          if (!isSessionActive(sessionId)) return;
          setPlayerTitle(cfg.title || null);
          setPlayerAnchorName(cfg.anchorName || null);
          setPlayerAvatar(cfg.avatar || null);
          setPlayerIsLive(true);
          if (cfg.qualities.length > 0) {
            setQualityOptionsOverride(cfg.qualities);
          }
          const nextKind: "hls" | "flv" = "hls";
          const player = playerRef.current;
          const canSoftSwitch =
            !!player &&
            !!danmuOverlayRef.current &&
            typeof player.switchURL === "function" &&
            !!playbackKindRef.current &&
            playbackKindRef.current === nextKind;
          if (canSoftSwitch) {
            try {
              const ret = player.switchURL(cfg.streamUrl, { seamless: false });
              if (ret && typeof (ret as any).then === "function") await ret;
              if (isSessionActive(sessionId)) {
                playbackKindRef.current = nextKind;
                await startDanmaku(sessionId, danmuOverlayRef.current, platform, roomId);
              }
            } catch {
              destroyPlayer();
              await mountPlayer(sessionId, cfg.streamUrl, cfg.streamType);
            }
          } else {
            destroyPlayer();
            await mountPlayer(sessionId, cfg.streamUrl, cfg.streamType);
          }
        }
      } catch (e: any) {
        if (!isSessionActive(sessionId)) return;
        // 取流失败：先清掉上一路的播放画面/缓冲，避免残留。
        destroyPlayer();
        const msg = e?.message ? String(e.message) : String(e);

        if (isOfflineMessage(msg) || reconnectBlockedRef.current) {
          // 业务层判定：主播确实未开播 / 房间不存在。
          // 显示「主播未开播」并**停止自动重连**，否则会对着已下播的房间反复空转。
          reconnectBlockedRef.current = true;
          reconnectAttemptRef.current = 0;
          setReconnectNotice(null);
          setStreamError(maybeAppendHevcInstallHint(msg));
          setIsOfflineError(true);
          setPlayerIsLive(false);
        } else {
          // 网络层中断：取流请求失败，但没有「未开播」特征 —— 大概率只是断网/超时。
          // 关键：绝不能沿用旧的「取流失败一律当作主播未开播」逻辑，
          // 那会在断网时弹出误导性的「主播未开播」，并让自动重连当场失效。
          // 这里保持画面为「正在重连」，交由退避调度器继续尝试，网络恢复即自动续播。
          setStreamError(null);
          setIsOfflineError(false);
          pendingReconnectReason = "取流失败";
        }
      } finally {
        if (isSessionActive(sessionId)) {
          setIsLoadingStream(false);
        }
        reloadInFlightRef.current = false;
        // 网络中断：等 in-flight 守卫复位后再调度重连
        if (pendingReconnectReason !== null) {
          scheduleReconnect(pendingReconnectReason);
        }
        const pending = pendingReloadRef.current;
        pendingReloadRef.current = null;
        if (pending) {
          void reloadStream(pending.trigger, pending.overrides, pending.opts);
        }
      }
    },
    [
      currentLine,
      currentQuality,
      destroyPlayer,
      isSessionActive,
      lineOptions,
      mountPlayer,
      platform,
      roomId,
      stopAllDanmakuBackends,
      stopAllProxies,
      scheduleReconnect
    ]
  );

  useEffect(() => {
    reloadStreamRef.current = reloadStream;
  }, [reloadStream]);

  useEffect(() => {
    // Create a per-mount generation id to guard delayed stop against StrictMode(dev) remounts.
    (globalThis as any).__DTV_PLAYER_MOUNT_GEN = ((globalThis as any).__DTV_PLAYER_MOUNT_GEN ?? 0) + 1;
    mountGenRef.current = (globalThis as any).__DTV_PLAYER_MOUNT_GEN;
    return () => {
      disposedRef.current = true;
      destroyPlayer();

      const capturedGen = mountGenRef.current;
      const stopAll = () => {
        const currentGen = (globalThis as any).__DTV_PLAYER_MOUNT_GEN ?? 0;
        if (currentGen !== capturedGen) return;
        void stopAllDanmakuBackends();
        void stopAllProxies();
      };
      if (process.env.NODE_ENV === "development") {
        window.setTimeout(stopAll, 200);
      } else {
        stopAll();
      }
    };
  }, [destroyPlayer, stopAllDanmakuBackends, stopAllProxies]);

  useEffect(() => {
    disposedRef.current = false;
    void reloadStream("refresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, roomId]);

  useEffect(() => {
    // Keep danmu overlay + controls in sync
    import("@/components/player/danmuOverlay")
      .then((mod: any) => {
        mod.applyDanmuOverlayPreferences?.(danmuOverlayRef.current, danmuSettings, isDanmuEnabled, playerRef.current?.root as any);
        mod.syncDanmuEnabledState?.(danmuOverlayRef.current, danmuSettings, isDanmuEnabled, playerRef.current?.root as any);
      })
      .catch(() => {});

    try {
      persistDanmuPreferences({ enabled: isDanmuEnabled, settings: danmuSettings });
    } catch {
      // ignore
    }

    try {
      danmuTogglePluginRef.current?.setState?.(isDanmuEnabled);
      danmuSettingsPluginRef.current?.setSettings?.(danmuSettings);
    } catch {
      // ignore
    }
  }, [danmuSettings, isDanmuEnabled]);

  useEffect(() => {
    try {
      persistDanmuKeywordBlockPreferences(danmuKeywordBlock);
    } catch {
      // ignore
    }

    try {
      danmuKeywordBlockPluginRef.current?.setPreferences?.(danmuKeywordBlock);
    } catch {
      // ignore
    }
  }, [danmuKeywordBlock]);

  useEffect(() => {
    try {
      qualityPluginRef.current?.setOptions?.([...effectiveQualityOptions]);
      qualityPluginRef.current?.updateLabel?.(currentQuality);
      linePluginRef.current?.setOptions?.([...lineOptions]);
      linePluginRef.current?.updateLabel?.(lineOptions.find((o) => o.key === resolveCurrentLineFor(lineOptions, currentLine))?.label ?? "线路");
    } catch {
      // ignore
    }
  }, [currentLine, currentQuality, effectiveQualityOptions, lineOptions]);

  useEffect(() => {
    // quality / line change triggers reload (debounced a bit)
    if (!qualityReloadArmedRef.current) {
      qualityReloadArmedRef.current = true;
      return;
    }
    const id = window.setTimeout(() => void reloadStream("quality"), 80);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuality, currentLine]);

  const followPayload = useMemo<FollowedStreamer>(() => {
    const fp: FollowPlatform =
      platform === Platform.DOUYU
        ? "DOUYU"
        : platform === Platform.DOUYIN
          ? "DOUYIN"
          : platform === Platform.HUYA
            ? "HUYA"
            : platform === Platform.TWITCH
              ? "TWITCH"
              : "BILIBILI";

    return {
      id: roomId,
      platform: fp,
      nickname: playerAnchorName || roomId,
      avatarUrl: playerAvatar || "",
      roomTitle: playerTitle || "",
      currentRoomId: roomId,
      liveStatus: "UNKNOWN"
    };
  }, [platform, playerAnchorName, playerAvatar, playerTitle, roomId]);

  return (
    <div
      className={`player-page${chromeHiddenClass}`}
      ref={pageRef}
      onPointerDownCapture={onPlayerPointerDownCapture}
      onPointerMoveCapture={onPlayerPointerMoveCapture}
      onPointerUpCapture={onPlayerPointerUpCapture}
      onPointerCancelCapture={onPlayerPointerUpCapture}
    >
      {isWindows ? (
        <div className="player-window-controls" data-tauri-drag-region="false" aria-label="窗口控制">
          <button type="button" className="window-btn" data-tauri-drag-region="false" aria-label="最小化" onClick={() => void minimizeWindow()}>
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M6 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="window-btn"
            data-tauri-drag-region="false"
            aria-label={isMaximized ? "还原" : "最大化"}
            onClick={() => void toggleMaximizeWindow()}
          >
            {!isMaximized ? (
              <svg viewBox="0 0 24 24" fill="none">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M9 7.5h8a2 2 0 0 1 2 2v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="5.5" y="9.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="window-btn window-btn--close"
            data-tauri-drag-region="false"
            aria-label="关闭软件"
            onClick={() => void closeWindow()}
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M7 7l10 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}

      <div className="player-layout">
        <div className="main-content">
          <div className="player-container player-container--solo">
            <div className="video-container">
              <div className="player-topbar">
                <div className="player-topbar-left">
                  <button
                    type="button"
                    className="player-close-btn"
                    title="关闭"
                    aria-label="关闭"
                    onClick={() => {
                      if (onRequestCloseAction) onRequestCloseAction();
                      else router.back();
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>

                  <div className="player-topbar-streamer" title={playerTitle || roomId}>
                    <div className="player-topbar-avatar">
                      {playerAvatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={getAvatarSrc(platform, playerAvatar)} alt={playerAnchorName ?? roomId} />
                      ) : (
                        <div className="player-topbar-avatarFallback">{(playerAnchorName || roomId || "D").charAt(0).toUpperCase()}</div>
                      )}
                    </div>
                    <div className="player-topbar-meta">
                      <div className="player-topbar-title">{playerTitle || roomId}</div>
                      <div className="player-topbar-sub">
                        {playerAnchorName || "未知主播"} · ID:{roomId}
                      </div>
                    </div>
                    <div className={`player-topbar-status ${playerIsLive === false ? "is-offline" : "is-live"}`}>
                      {isLoadingStream ? "加载中" : playerIsLive === false ? "未开播" : "直播中"}
                    </div>
                    <button
                      type="button"
                      className={`player-topbar-follow ${isFollowed ? "is-following" : ""}`}
                      onClick={() => {
                        if (isFollowed) follow.unfollowStreamer(followPayload.platform, followPayload.id);
                        else follow.followStreamer(followPayload);
                      }}
                    >
                      {isFollowed ? "取关" : "关注"}
                    </button>
                  </div>
                </div>
              </div>

              <div ref={playerContainerRef} className="video-player" />


              {isLoadingStream ? (
                <div className="loading-player" style={{ position: "absolute", inset: 0, zIndex: 20 }}>
                </div>
              ) : null}

              {/* 自动重连提示：只做轻量提示，不挡住画面的交互（pointer-events: none） */}
              {reconnectNotice && !streamError ? (
                <div className="reconnect-toast">
                  <span className="reconnect-spinner" aria-hidden="true" />
                  <span>{reconnectNotice}</span>
                </div>
              ) : null}

              {streamError ? (
                <div className={isOfflineError ? "offline-player" : "error-player"} style={{ position: "absolute", inset: 0, zIndex: 20 }}>
                  <div style={{ padding: 18, width: "min(520px, 92vw)", margin: "0 auto", textAlign: "left" }}>
                    <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>{isOfflineError ? "主播未开播" : "加载失败"}</div>
                    <div style={{ color: "var(--secondary-text)", fontWeight: 600, whiteSpace: "pre-wrap" }}>{streamError}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-start" }}>
                      <button className="retry-btn" onClick={() => void reloadStream("refresh")}>
                        再试一次
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
