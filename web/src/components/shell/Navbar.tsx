"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, ExternalLink, LayoutGrid, MonitorSmartphone, Moon, Search, Settings, Sun, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import styles from "./Navbar.module.css";
import { LanSyncModal } from "./LanSyncModal";
import { searchAnchors, type SearchAnchorResult, type SearchPlatform } from "@/services/search";
import { usePlayerUi } from "@/state/playerUi/PlayerUiProvider";
import { useFollow, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { Platform } from "@/platforms/common/types";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useCustomCategories } from "@/state/customCategories/CustomCategoriesProvider";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useAppSettings } from "@/state/settings/SettingsProvider";
import { SettingsModal } from "@/components/settings/SettingsModal";

type UiPlatform = "douyu" | "douyin" | "huya" | "bilibili" | "twitch" | "custom";

type VersionInfo = {
  version: string;
  title?: string;
  notes?: string[];
  url?: string;
  published_at?: string;
  /** 安装包字节数，用于让 Rust 侧判断本地是否已下载完整安装包 */
  size?: number;
};

const GITHUB_RELEASES_URL = "https://github.com/cookie-kangd/dtv_x/releases";

const basePlatforms: Array<{ id: Exclude<UiPlatform, "custom">; name: string }> = [
  { id: "douyu", name: "斗鱼" },
  { id: "huya", name: "虎牙" },
  { id: "douyin", name: "抖音" },
  { id: "bilibili", name: "B站" },
  { id: "twitch", name: "Twitch" }
];

const customPlatform = { id: "custom" as const, name: "自定义" };

/**
 * 搜索结果关注/取关按钮的定色兜底。
 * 内联样式优先级最高：即使全局 button 复位规则（border/background: none）
 * 因加载顺序或特异性问题胜出，按钮的实心底色与白字也一定生效。
 * 其余尺寸/圆角/hover 反馈仍由 Navbar.module.css 的 .searchFollowBtn 提供。
 */
const followBtnColorStyle: React.CSSProperties = {
  backgroundColor: "#22c55e",
  backgroundImage: "none",
  color: "#ffffff"
};

const unfollowBtnColorStyle: React.CSSProperties = {
  backgroundColor: "#ef4444",
  backgroundImage: "none",
  color: "#ffffff"
};

function WinCaptionMinimizeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function WinCaptionMaximizeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function WinCaptionRestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 7.5h8a2 2 0 0 1 2 2v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="5.5" y="9.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function WinCaptionCloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 7l10 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Navbar({
  theme,
  activePlatform,
  onThemeToggle,
  onPlatformChange
}: {
  theme: "light" | "dark";
  activePlatform: UiPlatform;
  onThemeToggle: () => void;
  onPlatformChange: (p: UiPlatform) => void;
}) {
  const pathname = usePathname();
  const [isWindows, setIsWindows] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const [updateOpen, setUpdateOpen] = useState(false);
  const [lanSyncOpen, setLanSyncOpen] = useState(false);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [localVersion, setLocalVersion] = useState<string>("");
  const [updatePhase, setUpdatePhase] = useState<"idle" | "downloading" | "installing" | "launched" | "error">("idle");
  const [updatePercent, setUpdatePercent] = useState<number>(0);
  const [updateMsg, setUpdateMsg] = useState<string>("");
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  // 应用内更新：下载进度事件（Rust 侧 download_and_install_cmd 发出）
  useEffect(() => {
    const un = listen<{
      // launched = 安装向导已启动且本应用仍存活（正常安装路径），按钮需恢复可点
      phase: "downloading" | "installing" | "launched" | "error";
      percent: number;
      message?: string;
    }>("update-progress", (e) => {
      const p = e.payload;
      if (!p?.phase) return;
      setUpdatePhase(p.phase);
      if (typeof p.percent === "number") setUpdatePercent(p.percent);
      setUpdateMsg(p.message || "");
    });
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  const startUpdate = useCallback(async () => {
    if (!versionInfo?.url || updatePhase === "downloading" || updatePhase === "installing") return;
    setUpdatePhase("downloading");
    setUpdatePercent(0);
    setUpdateMsg("正在连接下载源…");
    try {
      // Rust 侧行为：本地已有完整安装包 → 跳过下载直接进入安装；
      // 否则下载完成后关闭文件句柄 → 直接启动 NSIS 安装向导（不经 cmd，
      // 因此不会闪黑窗）。已安装时由安装器自己关闭 DTV_X，本应用保持存活。
      await invoke("download_and_install_cmd", {
        url: versionInfo.url,
        version: versionInfo.version,
        size: versionInfo.size ?? null
      });
      // 兜底：正常情况下 Rust 的 update-progress 事件已经把状态改对了，
      // 这里只处理事件因退出而丢失的情况。
      setUpdatePhase((prev) => (prev === "downloading" ? "launched" : prev));
      setUpdateMsg((prev) => prev || "安装向导已启动，请按提示完成安装");
    } catch (err) {
      setUpdatePhase("error");
      setUpdateMsg(typeof err === "string" ? err : String(err));
    }
  }, [versionInfo, updatePhase]);

  const playerUi = usePlayerUi();
  const playerOverlay = usePlayerOverlay();
  const follow = useFollow();
  const { ensureProxyStarted, proxify } = useImageProxy();
  const custom = useCustomCategories();

  const showCustomTab = custom.hydrated && custom.entries.length > 0;
  const appSettings = useAppSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 平台设置：启用开关 + 排序（设置面板可改，全局生效 + 持久化）
  const orderedBasePlatforms = useMemo(() => {
    const enabled = basePlatforms.filter((p) => appSettings.settings.enabledPlatforms[p.id] !== false);
    const order = appSettings.settings.platformOrder;
    if (!order.length) return enabled;
    return [...enabled].sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  }, [appSettings.settings.enabledPlatforms, appSettings.settings.platformOrder]);

  const visiblePlatforms = useMemo(() => {
    // 对齐老项目：有自定义分区时，自定义入口放在最前面
    if (showCustomTab) return [customPlatform, ...orderedBasePlatforms];
    return orderedBasePlatforms;
  }, [showCustomTab, orderedBasePlatforms]);

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState<{ width: number; x: number; opacity: number }>({ width: 0, x: 0, opacity: 0 });

  const highlightMotionWithOpacity = useMemo(
    () => ({
      width: highlight.width,
      x: highlight.x,
      opacity: highlight.opacity,
      scale: highlight.opacity ? 1 : 0.96
    }),
    [highlight]
  );

  const isPlayerRoute = (pathname ?? "").startsWith("/player");
  const isPlayerOpen = isPlayerRoute || playerOverlay.isOpen;

  const navigateToPlayer = useCallback(
    (platform: string, roomId: string) => {
      playerOverlay.openPlayer({ platform, roomId });
    },
    [playerOverlay]
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchAnchorResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [playerSearchOpen, setPlayerSearchOpen] = useState(true);

  useEffect(() => {
    if (isPlayerOpen) {
      setPlayerSearchOpen(false);
      setSearchQuery("");
      setSearchResults([]);
      setSearchError(null);
      setIsSearchFocused(false);
    } else {
      setPlayerSearchOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlayerOpen]);

  const openPlayerSearch = useCallback(() => {
    setPlayerSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, []);

  // 请求序号：手动打开弹窗触发的检查若先返回，不会被更早的慢响应覆盖
  const versionCheckSeqRef = useRef(0);

  /** 主动检查一次更新（挂载时 + 每次打开版本弹窗时都会调用） */
  const checkUpdate = useCallback(async () => {
    const seq = ++versionCheckSeqRef.current;
    setIsCheckingUpdate(true);
    try {
      // 版本检查不是关键功能：失败不重试、不报错、不提示
      const res = await invoke<any>("check_version_cmd");
      if (seq !== versionCheckSeqRef.current) return; // 已过期，丢弃
      const local = typeof res?.local_version === "string" ? res.local_version : "";
      setLocalVersion(local);
      const remote = res?.remote;
      if (remote && typeof remote.version === "string" && remote.version.trim()) {
        const info: VersionInfo = {
          version: remote.version,
          title: typeof remote.title === "string" ? remote.title : undefined,
          notes: Array.isArray(remote.notes) ? remote.notes.filter((x: any) => typeof x === "string") : undefined,
          url: typeof remote.url === "string" ? remote.url : undefined,
          published_at: typeof remote.published_at === "string" ? remote.published_at : undefined,
          size: typeof remote.size === "number" ? remote.size : undefined
        };
        setVersionInfo(info);
      }
      setHasUpdate(!!res?.has_update);
    } catch {
      // ignore
    } finally {
      if (seq === versionCheckSeqRef.current) setIsCheckingUpdate(false);
    }
  }, []);

  // 启动时检查一次（用于标题栏的 NEW 徽标）
  useEffect(() => {
    void checkUpdate();
  }, [checkUpdate]);

  /** 点击版本按钮：打开弹窗，并每次都主动检查一次更新 */
  const openUpdateModal = useCallback(() => {
    setUpdateOpen(true);
    if (updatePhase === "error") {
      // 上次更新失败：清掉错误提示，重新进入可点击状态（安装包会被复用，不会重新下载）
      setUpdatePhase("idle");
      setUpdateMsg("");
      setUpdatePercent(0);
    }
    void checkUpdate();
  }, [checkUpdate, updatePhase]);

  const searchPlatform: SearchPlatform | null = useMemo(() => {
    if (activePlatform === "bilibili") return "bilibili";
    if (activePlatform === "huya") return "huya";
    if (activePlatform === "douyu") return "douyu";
    return null; // custom / douyin：暂不支持统一搜索
  }, [activePlatform]);

  const placeholderText = useMemo(() => {
    return "搜索主播/房间";
  }, []);

  // 搜索结果开播状态校正缓存：key = platform:roomId，避免重复请求
  const liveStatusCacheRef = useRef<Map<string, boolean>>(new Map());

  /** 用关注列表同源接口校正搜索结果的开播状态（并发 3，最多 12 条） */
  const correctSearchLiveStatus = useCallback(
    async (list: SearchAnchorResult[], apply: (next: SearchAnchorResult[]) => void, isCancelled?: () => boolean) => {
      const targets = list.slice(0, 12);
      if (!targets.length) return;

      const results = new Map<string, boolean>();
      let idx = 0;
      const worker = async () => {
        while (idx < targets.length) {
          const item = targets[idx];
          idx += 1;
          const key = `${item.platform}:${item.roomId}`;
          const cached = liveStatusCacheRef.current.get(key);
          if (cached !== undefined) {
            results.set(key, cached);
            continue;
          }
          try {
            let live = item.liveStatus;
            if (item.platform === "douyu") {
              const info = await invoke<any>("fetch_douyu_room_info", { roomId: item.roomId });
              const showStatus = Number(info?.show_status ?? 0);
              const loop = Number(info?.video_loop ?? info?.videoLoop ?? NaN);
              // 与关注列表一致：show_status===1 即开播，仅 video_loop===1（轮播）视为未开播
              live = showStatus === 1 && loop !== 1;
            } else if (item.platform === "huya") {
              const info = await invoke<any>("get_huya_unified_cmd", { roomId: item.roomId, quality: null, line: null });
              live = !!info?.is_live;
            } else if (item.platform === "bilibili") {
              const payload = { platform: "BILIBILI", args: { room_id_str: item.roomId } };
              const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") || null : null;
              const info = await invoke<any>("fetch_bilibili_streamer_info", { payload, cookie });
              live = Number(info?.status ?? 0) === 1;
            }
            liveStatusCacheRef.current.set(key, live);
            results.set(key, live);
          } catch {
            // 校正失败保持原值，不写缓存（下次可重试）
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));

      if (!results.size) return;
      // 关键词已变化/组件卸载时放弃写回，避免旧结果覆盖新查询
      if (isCancelled && isCancelled()) return;
      apply(
        list.map((item) => {
          const fixed = results.get(`${item.platform}:${item.roomId}`);
          return fixed === undefined ? item : { ...item, liveStatus: fixed };
        })
      );
    },
    []
  );

  useEffect(() => {
    const trimmed = searchQuery.trim();
    setSearchError(null);
    if (!trimmed || !searchPlatform) {
      setSearchResults([]);
      setIsLoadingSearch(false);
      return;
    }

    // 竞态防护：请求真正发出后（220ms 防抖已过）用户若又改了关键词，
    // 旧请求的响应不能再写回 state，否则会覆盖新查询的结果（表现为结果串台/闪烁）。
    let cancelled = false;

    setIsLoadingSearch(true);
    const id = window.setTimeout(() => {
      searchAnchors(searchPlatform, trimmed)
        .then((res) => {
          if (cancelled) return;
          const list = res ?? [];
          setSearchResults(list);
          // 搜索接口返回的开播状态不可靠（斗鱼 videoLoop/虎牙 live_status 常误判），
          // 用与关注列表同源的房间详情接口异步校正，保证两处状态一致。
          void correctSearchLiveStatus(list, setSearchResults, () => cancelled);
        })
        .catch((e: any) => {
          if (cancelled) return;
          setSearchResults([]);
          setSearchError(typeof e === "string" ? e : e?.message || "搜索失败");
        })
        .finally(() => {
          if (!cancelled) setIsLoadingSearch(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [correctSearchLiveStatus, searchPlatform, searchQuery]);

  useEffect(() => {
    if (searchPlatform === "bilibili" || searchPlatform === "huya") {
      void ensureProxyStarted();
    }
  }, [ensureProxyStarted, searchPlatform]);

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

  const updateHighlight = useCallback(() => {
    const el = tabRefs.current[activePlatform];
    const container = containerRef.current;
    if (!el || !container) {
      setHighlight((prev) => ({ ...prev, opacity: 0 }));
      return;
    }
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setHighlight({ width: r.width, x: r.left - c.left, opacity: 1 });
  }, [activePlatform]);

  const openExternal = useCallback(async (url: string) => {
    const raw = String(url || "").trim();
    if (!raw) return;

    const normalizedUrl = (() => {
      try {
        return new URL(raw).toString();
      } catch {
        // allow passing github.com/xxx
        try {
          return new URL(`https://${raw}`).toString();
        } catch {
          return raw;
        }
      }
    })();

    try {
      await invoke("open_in_default_browser", { url: normalizedUrl });
      return;
    } catch {
      // ignore
    }
    try {
      const opener: any = await import("@tauri-apps/plugin-opener");
      if (typeof opener?.open === "function") {
        await opener.open(normalizedUrl);
        return;
      }
    } catch {
      // ignore
    }
    try {
      window.open(normalizedUrl, "_blank", "noopener,noreferrer");
    } catch {
      // ignore
    }
  }, []);

  useLayoutEffect(() => {
    updateHighlight();
    // 依赖 visiblePlatforms（数组身份在平台启停/排序变化时都会更新）：
    // 排序变化时 length 不变，若只依赖 length 会导致高亮块停留在旧位置，
    // 压在错误的平台下方，出现「某些平台文字变白」的观感。
  }, [updateHighlight, visiblePlatforms]);

  useEffect(() => {
    const onResize = () => updateHighlight();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateHighlight]);

  const island = playerUi.island;
  const islandDisplayName = island.anchorName || island.roomId || "";
  const islandDisplayTitle = island.title || "";

  const islandIsFollowed = useMemo(() => {
    if (!island.visible || !island.platform || !island.roomId) return false;
    const fp: FollowPlatform =
      island.platform === Platform.DOUYU
        ? "DOUYU"
        : island.platform === Platform.DOUYIN
          ? "DOUYIN"
          : island.platform === Platform.HUYA
            ? "HUYA"
            : island.platform === Platform.TWITCH
              ? "TWITCH"
              : "BILIBILI";
    return follow.isFollowed(fp, island.roomId);
  }, [follow, island.platform, island.roomId, island.visible]);

  const showResults = isSearchFocused && !!searchQuery.trim();

  return (
    <nav className={`${styles.navbar} ${theme === "dark" ? styles.navbarDark : ""}`} data-tauri-drag-region>
      <div className={styles.platformTabsWrap} data-tauri-drag-region>
        <div className={styles.platformTabs} ref={containerRef} data-tauri-drag-region>
          <m.div
            className={styles.platformHighlight}
            initial={false}
            animate={highlightMotionWithOpacity}
            transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.85 }}
          />
          {visiblePlatforms.map((p) => (
            <button
              // eslint-disable-next-line react/no-unknown-property
              data-tauri-drag-region="false"
              key={p.id}
              type="button"
              className={`${styles.platformTab} ${activePlatform === p.id ? styles.platformTabActive : ""}`}
              ref={(node) => {
                tabRefs.current[p.id] = node;
              }}
              onClick={() => onPlatformChange(p.id)}
            >
              {p.id === "custom" ? <LayoutGrid size={16} /> : p.name}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isPlayerRoute && island.visible && island.roomId && (playerUi.danmuPanel.collapsed || !playerUi.danmuPanel.available) ? (
          <m.div
            className={styles.playerIsland}
            data-tauri-drag-region="false"
            initial={{ opacity: 0, y: -10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } }}
            exit={{ opacity: 0, y: -8, scale: 0.99, transition: { duration: 0.12 } }}
          >
            <div className={styles.playerIslandLeft}>
              {island.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.playerIslandAvatar} src={island.avatarUrl} alt={islandDisplayName} />
              ) : (
                <div className={`${styles.playerIslandAvatar} ${styles.playerIslandAvatarFallback}`}>
                  {(islandDisplayName || "?").slice(0, 1)}
                </div>
              )}
              <div className={styles.playerIslandMeta}>
                <div className={styles.playerIslandName} title={islandDisplayName}>
                  {islandDisplayName}
                </div>
                <div className={styles.playerIslandTitle} title={islandDisplayTitle}>
                  {islandDisplayTitle}
                </div>
              </div>
            </div>
            <m.button
              type="button"
              className={`${styles.playerIslandFollow} ${islandIsFollowed ? styles.playerIslandFollowed : ""}`}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.7 }}
              onClick={() => {
                if (!island.platform || !island.roomId) return;
                const fp: FollowPlatform =
                  island.platform === Platform.DOUYU
                    ? "DOUYU"
                    : island.platform === Platform.DOUYIN
                      ? "DOUYIN"
                      : island.platform === Platform.HUYA
                        ? "HUYA"
                        : island.platform === Platform.TWITCH
                          ? "TWITCH"
                          : "BILIBILI";
                if (follow.isFollowed(fp, island.roomId)) follow.unfollowStreamer(fp, island.roomId);
                else {
                  follow.followStreamer({
                    id: island.roomId,
                    platform: fp,
                    nickname: islandDisplayName || island.roomId,
                    avatarUrl: island.avatarUrl || "",
                    roomTitle: island.title || "",
                    currentRoomId: island.roomId,
                    liveStatus: "UNKNOWN"
                  });
                }
              }}
            >
              {islandIsFollowed ? "取关" : "关注"}
            </m.button>
            <button
              type="button"
              className={styles.playerIslandExpand}
              title={playerUi.danmuPanel.available ? "展开弹幕" : "当前窗口过窄，无法展开弹幕列表"}
              disabled={!playerUi.danmuPanel.available}
              onClick={() => playerUi.requestShowDanmuPanel()}
            >
              <ChevronDown size={14} />
            </button>
          </m.div>
        ) : null}
      </AnimatePresence>

      <div className={styles.actions} data-tauri-drag-region>
        {activePlatform !== "custom" ? (
          <div className={styles.searchContainer} data-tauri-drag-region="false">
          {isPlayerRoute && !playerSearchOpen ? (
            <m.button
              type="button"
              className={styles.searchIconBtn}
              aria-label="打开搜索"
              title="搜索"
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.96 }}
              transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
              onClick={openPlayerSearch}
            >
              <Search size={16} />
            </m.button>
          ) : null}

          <m.div
            className={`${styles.searchShell} ${isSearchFocused ? styles.searchShellFocused : ""}`}
            initial={false}
            animate={isPlayerRoute ? { width: playerSearchOpen ? 320 : 36, opacity: playerSearchOpen ? 1 : 0 } : undefined}
            transition={isPlayerRoute ? { type: "spring", stiffness: 520, damping: 44, mass: 0.7 } : undefined}
            style={isPlayerRoute ? { maxWidth: "36vw", overflow: "hidden", display: playerSearchOpen ? "inline-flex" : "none" } : undefined}
          >
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={placeholderText}
              className={styles.searchInput}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => {
                setIsSearchFocused(false);
                if (!isPlayerRoute) return;
                if (searchQuery.trim()) return;
                window.setTimeout(() => setPlayerSearchOpen(false), 80);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (!isPlayerRoute) return;
                  setSearchQuery("");
                  setSearchResults([]);
                  setSearchError(null);
                  setIsSearchFocused(false);
                  setPlayerSearchOpen(false);
                  return;
                }
                if (e.key !== "Enter") return;
                const trimmed = searchQuery.trim();
                if (!trimmed) return;
                if (/^\d+$/.test(trimmed)) {
                  navigateToPlayer(activePlatform, trimmed);
                }
              }}
            />
            {searchQuery ? (
              <button
                type="button"
                className={styles.searchIconBtn}
                aria-label="清除搜索"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSearchQuery("");
                  setSearchResults([]);
                  setSearchError(null);
                }}
              >
                <X size={14} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.searchIconBtn}
              aria-label="搜索"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const trimmed = searchQuery.trim();
                if (!trimmed) return;
                if (/^\d+$/.test(trimmed)) {
                  navigateToPlayer(activePlatform, trimmed);
                }
              }}
            >
              <Search size={15} />
            </button>
          </m.div>

          {showResults ? (
            <div className={styles.searchResultsWrapper}>
              {isLoadingSearch ? <div className={styles.searchMeta}>搜索中...</div> : null}
              {!isLoadingSearch && searchError ? <div className={styles.searchMeta}>{searchError}</div> : null}
              {!isLoadingSearch && !searchError && searchResults.length ? (
                <div className={styles.searchResultsList}>
                  {searchResults.map((anchor) => {
                    const followPlatform = String(anchor.platform).toUpperCase() as FollowPlatform;
                    const isAnchorFollowed = follow.isFollowed(followPlatform, anchor.roomId);
                    return (
                    <div
                      key={`${anchor.platform}-${anchor.roomId}`}
                      className={styles.searchResultItem}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        navigateToPlayer(anchor.platform, anchor.roomId);
                      }}
                    >
                      <div className={styles.resultAvatar}>
                        {anchor.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            className={styles.resultAvatarImg}
                            src={anchor.platform === "bilibili" || anchor.platform === "huya" ? proxify(anchor.avatar) : anchor.avatar}
                            alt={anchor.userName}
                          />
                        ) : (
                          <div className={styles.resultAvatarFallback}>{(anchor.userName || "?").slice(0, 1)}</div>
                        )}
                        <span
                          className={`${styles.liveDot} ${anchor.liveStatus ? styles.liveDotLive : styles.liveDotOff}`}
                          title={anchor.liveStatus ? "开播中" : "未开播"}
                          aria-hidden="true"
                        />
                      </div>
                      <div className={styles.resultMain}>
                        <div className={styles.resultName} title={anchor.userName}>
                          {anchor.userName}
                        </div>
                        <div className={styles.resultTitle} title={anchor.roomTitle}>
                          {anchor.roomTitle}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`${styles.searchFollowBtn} ${isAnchorFollowed ? styles.searchFollowBtnActive : ""}`}
                        data-slot="button"
                        style={isAnchorFollowed ? unfollowBtnColorStyle : followBtnColorStyle}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isAnchorFollowed) {
                            follow.unfollowStreamer(followPlatform, anchor.roomId);
                          } else {
                            follow.followStreamer({
                              id: anchor.roomId,
                              platform: followPlatform,
                              nickname: anchor.userName || anchor.roomId,
                              avatarUrl: anchor.avatar || "",
                              roomTitle: anchor.roomTitle || "",
                              currentRoomId: anchor.roomId,
                              liveStatus: anchor.liveStatus ? "LIVE" : "OFFLINE"
                            });
                          }
                        }}
                      >
                        {isAnchorFollowed ? "取关" : "关注"}
                      </button>
                    </div>
                    );
                  })}
                </div>
              ) : null}

              {!isLoadingSearch && !searchError && !searchResults.length ? (
                <div className={styles.searchMeta}>
                  未找到结果
                  {searchQuery.trim() && /^\d+$/.test(searchQuery.trim()) ? (
                    <button
                      type="button"
                      className={styles.searchFallbackBtn}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const rid = searchQuery.trim();
                        navigateToPlayer(activePlatform, rid);
                      }}
                    >
                      进入房间 {searchQuery.trim()}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          </div>
        ) : null}

        <button
          type="button"
          // eslint-disable-next-line react/no-unknown-property
          data-tauri-drag-region="false"
          className={styles.versionBtn}
          title="版本信息"
          aria-label="版本信息"
          onClick={openUpdateModal}
        >
          <span className={styles.versionText}>v{localVersion || "?"}</span>
          {hasUpdate ? <span className={styles.badgeNew}>NEW</span> : null}
        </button>

        <button
          type="button"
          // eslint-disable-next-line react/no-unknown-property
          data-tauri-drag-region="false"
          className={styles.navIconBtn}
          title="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={18} />
        </button>

        <button
          type="button"
          // eslint-disable-next-line react/no-unknown-property
          data-tauri-drag-region="false"
          className={styles.navIconBtn}
          title="Data Sync"
          aria-label="Data Sync"
          onClick={() => setLanSyncOpen(true)}
        >
          <MonitorSmartphone size={18} />
        </button>

        <button
          type="button"
          // eslint-disable-next-line react/no-unknown-property
          data-tauri-drag-region="false"
          className={`${styles.themeToggle} ${theme === "dark" ? styles.themeToggleDark : styles.themeToggleLight}`}
          onClick={onThemeToggle}
          aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {isWindows ? (
          <div className={styles.winControls} data-tauri-drag-region="false" aria-label="Window controls">
            <button type="button" className={styles.winBtn} title="最小化" onClick={() => void minimizeWindow()}>
              <WinCaptionMinimizeIcon />
            </button>
            <button type="button" className={styles.winBtn} title={isMaximized ? "还原" : "最大化"} onClick={() => void toggleMaximizeWindow()}>
              {isMaximized ? <WinCaptionRestoreIcon /> : <WinCaptionMaximizeIcon />}
            </button>
            <button type="button" className={`${styles.winBtn} ${styles.winBtnClose}`} title="关闭" onClick={() => void closeWindow()}>
              <WinCaptionCloseIcon />
            </button>
          </div>
        ) : null}
      </div>

      <AnimatePresence>
        {updateOpen ? (
          <m.div
            className={styles.overlayBackdrop}
            // eslint-disable-next-line react/no-unknown-property
            data-tauri-drag-region="false"
            // 注意：遮罩不要做 opacity 入场动画——WebView2 上 opacity 0→1 会先合成一帧
            // 纯黑底层再叠加内容，表现为"闪黑"（与设置弹窗同一个根因）。
            // 遮罩首帧即最终态，只让卡片做 transform 动画。
            initial={false}
            onMouseDown={() => setUpdateOpen(false)}
          >
            <m.div
              className={styles.overlayCard}
              initial={{ y: 12, scale: 0.985 }}
              animate={{ y: 0, scale: 1 }}
              exit={{ y: 8, scale: 0.99, transition: { duration: 0.1 } }}
              transition={{ type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className={styles.overlayHeader}>
                <div className={styles.overlayTitle}>
                  {hasUpdate && versionInfo
                    ? versionInfo.title || `发现新版本 v${versionInfo.version}`
                    : isCheckingUpdate
                      ? "正在检查更新…"
                      : "版本信息"}
                </div>
                <button type="button" className={styles.overlayClose} onClick={() => setUpdateOpen(false)} aria-label="关闭">
                  <X size={16} />
                </button>
              </div>
              <div className={styles.overlayBody}>
                <div className={styles.updateMeta}>
                  <span>当前版本：v{localVersion || "?"}</span>
                  {hasUpdate && versionInfo ? (
                    <span>最新版本：v{versionInfo.version}</span>
                  ) : isCheckingUpdate ? (
                    <span>正在检查更新…</span>
                  ) : (
                    <span>已是最新</span>
                  )}
                  {hasUpdate && versionInfo?.published_at ? <span>发布日期：{versionInfo.published_at}</span> : null}
                </div>
                {hasUpdate && versionInfo?.notes?.length ? (
                  <ul className={styles.updateNotes}>
                    {versionInfo.notes.map((n, idx) => (
                      <li key={`${idx}-${n}`}>{n}</li>
                    ))}
                  </ul>
                ) : null}

                {updatePhase === "downloading" || updatePhase === "installing" || updatePhase === "launched" ? (
                  <div className={styles.updateProgressWrap}>
                    <div className={styles.updateProgressTrack}>
                      <div
                        className={styles.updateProgressBar}
                        style={{ width: `${Math.min(100, Math.max(2, updatePercent))}%` }}
                      />
                    </div>
                    <div className={styles.updateProgressText}>
                      {updatePhase === "downloading"
                        ? `正在下载更新 ${updatePercent.toFixed(1)}%`
                        : updateMsg || "安装向导已启动，请按提示完成安装"}
                    </div>
                  </div>
                ) : null}
                {updatePhase === "error" ? <div className={styles.updateErrorText}>{updateMsg || "更新失败，请稍后重试或前往下载页"}</div> : null}

                <div className={styles.updateActions}>
                  {hasUpdate && versionInfo ? (
                    <>
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        disabled={updatePhase === "downloading" || updatePhase === "installing"}
                        onClick={() => void startUpdate()}
                      >
                        {updatePhase === "downloading"
                          ? "正在下载…"
                          : updatePhase === "installing"
                            ? "正在退出并启动安装…"
                            : updatePhase === "error"
                              ? "重试更新"
                              : updatePhase === "launched"
                                ? "再次启动安装向导"
                                : "立即更新"}
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => void openExternal((versionInfo?.url || GITHUB_RELEASES_URL) as string)}
                      >
                        <ExternalLink size={14} />
                        打开下载页
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => void openExternal((versionInfo?.url || GITHUB_RELEASES_URL) as string)}
                    >
                      <ExternalLink size={16} />
                      打开 GitHub
                    </button>
                  )}
                </div>
              </div>
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>

      <LanSyncModal open={lanSyncOpen} onClose={() => setLanSyncOpen(false)} appVersion={localVersion} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </nav>
  );
}
