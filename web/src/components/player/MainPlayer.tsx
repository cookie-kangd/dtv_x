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
  hasDanmuEnabledOverride,
  ICONS,
  loadDanmuKeywordBlockPreferences,
  loadDanmuPreferences,
  loadStoredVolume,
  persistDanmuEnabledOverride,
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
// ★ 重连成功后立刻进入「免打扰期」，期内不再因任何抖动触发新重连。
//   这是「网络稳定却一直触发重连」和「重连一次后就无限重连」两个问题的共同解药。
//   正确语义：**一次故障 = 一轮重连**，而不是「一次抖动 = 一次重连」。
//   重连成功（playing）即代表故障已结束，预算当场回满；
//   之后偶发的短暂卡顿应交回播放器内核自愈（disconnectRetryCount），
//   若连内核都救不回来，那说明是真的又断了一次 —— 但那要等免打扰期过后才算数。
const RECONNECT_COOLDOWN_MS = 20000;
const RECONNECT_MAX_ATTEMPTS = 6;
// 退避阶梯（刻意比教科书实现保守，起步 3s 而非 1s）：
//   1) 斗鱼/虎牙/B站的取流接口都有频控，秒级密集重取流极易被判异常而直接拒绝 ——
//      表现就是「每次自动重连都取流失败、手动点刷新却一次就成」。拉长间隔反而更容易恢复；
//   2) 一次重建要销毁旧播放器、停弹幕、重新取流、重新 mount，本身就要几秒，
//      1s 后重试基本是在跟自己抢资源。
const RECONNECT_DELAYS_MS = [3000, 6000, 12000, 20000, 30000, 45000];
// 退避总时长封顶：一轮重连（从第一次中断算起）超过这个时长就彻底放弃，交还控制权给用户。
// 这是「无限重连」的最后一道保险。
const RECONNECT_ROUND_WINDOW_MS = 240000; // 4 分钟，覆盖退避总和(116s) + 每次重建耗时
// 连续「取流阶段」失败这么多次，判定该房间当前就是取不到流，不再空转
const FETCH_FAIL_GIVEUP_STREAK = 3;
// 卡死看门狗：直播中「缓冲长时间不再增长且播放头也不动」才判定为「假死」
// （内核没抛 error、但画面停住——弱网/丢包时很常见，必须靠主动检测兜底）
const STALL_CHECK_INTERVAL_MS = 3000;
// ★★ 30s 而非 12s/20s —— 这是「网络明明稳定却一直重连」的直接解药。
//
// 第一性原理：判断直播是否还活着，唯一可靠的信号是「**播放器还在持续收数据**」，
// 而不是「画面在不在动」。直播是 live 流，画面完全静止（主播没动、静态画面）时
// 编码器几乎不吐新帧，currentTime 可以合法地几十秒不推进；
// 同时 MSE 为了追 live-edge 会主动把播放头钉在缓冲末尾，播放头不推进更是常态。
//
// 所以判据只用一条：**buffered.end() 是否还在增长**。
//只要还在增长 = 数据还在到 = 一切正常，哪怕画面定格。
// 增长停止（且播放头也不动）持续超过 STALL_STUCK_MS 才是真断流。
// 用 30s 是因为要留足一整个 GOP + 关键帧间隔的余量；
// 再短就会在网络轻微抖动时误报，反而制造 endless 重连。
const STALL_STUCK_MS = 30000;
// ===== 重连活性兜底（根治「自动重连若干次后就一直转圈」）=====
// 事件驱动的重连有一个致命弱点：链条上任何一环静默失败（守卫吞掉请求、
// await 永不返回），就再也没有人来推进下一次重连。因此必须由一个独立于
// 播放器生命周期的心跳来巡检重连是否还在推进。
// 单次取流/重建超过此时长一律视为挂死。
// 20s 而非 45s：正常重建（停弹幕→停代理→取流→mount）只要几秒，
// 45s 的观感就是「转圈转到天荒地老」，用户根本等不到看门狗来救就已经去手动刷新了。
const RELOAD_HARD_TIMEOUT_MS = 20000;

// 单个 Rust invoke 的兜底超时：绝不能让一个永不返回的 invoke 把整条重连链钉死。
// 停止类命令是幂等的，超时后继续往下走是安全的（下次重连会再停一次）。
const INVOKE_TIMEOUT_MS = 4000;

/**
 * 给单个 invoke 套超时兜底。
 * 背景：一次自动重连要串行 await 十几个 Rust 命令（停弹幕×5、停代理×2、取流、起弹幕…），
 * 只要其中任何一个永不返回，reloadInFlightRef 就被永久钉在 true，
 * 之后每次重连都被 in-flight 守卫挡下、只记一个「补偿调度」而永远等不到补偿
 * —— 用户看到的就是「一直黑屏转圈，手动点刷新才好」。
 * 注意：这里只让 await 不再阻塞，不取消底层调用；停止类命令幂等，重复执行无害。
 */
const invokeWithTimeout = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label} 超时`)), INVOKE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};

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

  // 全局默认弹幕开关：仅当用户从未手动设置过弹幕偏好时生效。
  //
  // ★ v0.2.13 修复：旧实现用 loadDanmuPreferences() 是否非空来判断「用户是否
  //   设置过偏好」，但本组件每次挂载都会 persistDanmuPreferences(...) 写盘，
  //   子组件 effect 又先于父组件执行 —— 等这里跑到时 localStorage 里必然已经
  //   有了自己写的偏好，于是 danmuDefaultOn 从此永久失效、且不报任何错。
  //   现在改用独立标记 hasDanmuEnabledOverride()（只由用户手动点开关写入）。
  useEffect(() => {
    if (!appSettings.hydrated) return;
    if (appSettings.settings.danmuDefaultOn) {
      // 默认开启：仅在用户从未手动表达过偏好时把状态拉回开启。
      if (!hasDanmuEnabledOverride()) setIsDanmuEnabled(true);
      return;
    }
    // 默认关闭：同样只在用户未手动设置过时生效。
    if (hasDanmuEnabledOverride()) return;
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
  // 弹幕事件的 Tauri 监听器集合。
  // ★ 刻意用 Set 而不是单个函数：reloadStream 明确支持「抢占」语义
  //   （用户点刷新可以抢在旧会话还在 await listen() 时启动新会话），
  //   于是两个会话的 listen() 可能交错返回。若用单值 ref，
  //   后完成的那个会覆盖先完成的，被覆盖的 unlisten 就此丢失 ——
  //   那个监听器会一直收到**所有平台**的 danmaku-message，
  //   每次都进回调才被 isSessionActive 挡掉，白耗 IPC 反序列化与回调开销，
  //   并且它持有的 overlay 引用会阻止旧弹幕实例被回收。
  const unlistenRef = useRef<Set<() => void>>(new Set());

  /** 解绑并清空所有弹幕事件监听器。 */
  const clearDanmakuListeners = useCallback(() => {
    unlistenRef.current.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore
      }
    });
    unlistenRef.current.clear();
  }, []);

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
  // 取流期间被守卫挡下的重连请求（不再丢弃，等本次取流结束后补偿调度）
  const reconnectDeferredRef = useRef(false);
  // 已经用尽重连次数、把控制权交还用户：此时停止一切自动重连，直到用户手动重载
  const reconnectGaveUpRef = useRef(false);
  // 本次 reloadStream 的起始时刻（看门狗用它判断取流是否挂死）
  const reloadStartedAtRef = useRef(0);
  // 本轮重连的起始时刻（第一次中断的时刻）——用于总时长封顶，杜绝「无限重连」
  const reconnectRoundStartRef = useRef(0);
  // ★ 免打扰期截止时刻。重连成功（playing）后到此时刻之前，任何抖动都不再触发新重连。
  //   这一个字段同时消灭了「网络稳定也重连」和「重连一次后无限重连」两个问题：
  //   以前是靠「连续稳定 15 秒才回血」来变相限流，但直播流 currentTime 天然会间歇性停住
  //   （MSE live-edge 钉住播放头等新数据），healthySince 反复被清零 → 预算永远回不满
  //   → 看门狗反复判定「重连链条停滞」→ 每 30 秒强制补一次重连 → 无限循环。
  //   现在改成显式的免打扰窗口，语义清晰且不受 currentTime 抖动影响。
  const reconnectCooldownUntilRef = useRef(0);
  // 连续「取流阶段」失败次数（取流成功即清零）——用于对取不到流的房间及时止损
  const fetchFailStreakRef = useRef(0);
  // 是否处于「自动重连重建」模式：用于让 destroyPlayer 保留全屏态
  const autoReconnectModeRef = useRef(false);
  // 一旦确认「主播未开播 / 房间不存在」就置位，阻断自动重连（否则会对着下播的房间空转）；
  // 成功播放或用户手动重载时解除。注意：网络中断**不**置位，必须继续重连。
  const reconnectBlockedRef = useRef(false);
  const stallWatchdogRef = useRef<number | null>(null);
  // 用户是否主动按了暂停。必须区分「用户主动暂停」与「播放器自己卡住」——
  // 两者在 video 元素上都表现为 paused === true，但前者绝不能触发重连。
  const userPausedRef = useRef(false);
  // 窗口被关到托盘（Rust 侧 hide）时置位，仅用于「后台要不要做重连判断」。
  //
  // ★ 产品要求：关到托盘后必须继续播放，直到用户真正退出应用为止。
  //   因此这里**不再** pause 视频、**不再**停弹幕与代理 —— 那是 v0.2.7 的旧行为，
  //   用户反馈「只要放后台就不播了」，已按需求推翻。
  //
  // 保留该标志的唯一原因是 Chromium 的后台节流：窗口不可见时
  // requestAnimationFrame / 定时器会被降频，解码与取流也可能短暂滞后。
  // 这期间若照常判定「卡死」，就会对完全正常的流发起重连 —— 那正是
  // 「后台待久了回来发现重连过」的真实成因。所以后台只做数据流入观测，不判故障。
  const windowHiddenRef = useRef(false);
  // ★ 最近一次「真实用户操作」的时刻（点击/按键），用于区分
  //   「用户主动暂停」与「系统/内核自动暂停」。
  //   两者在 <video> 上都表现为 paused === true，语义却完全相反。
  const lastUserInputAtRef = useRef(0);
  // 后台期间「数据链路完全中断」的起始时刻（readyState 归零计时用）
  const hiddenDeadSinceRef = useRef(0);
  // 画面最近一次「确实在推进」的 currentTime + 时刻。
  // 注意用 currentTime 判定推进本身就不可靠（直播是 live 流，播放头常被钉在缓冲末尾），
  // 所以它只用于「粗略发现画面完全没动过」，真正的卡死判定要看缓冲是否仍在增长。
  const lastProgressRef = useRef<{ time: number; at: number }>({ time: -1, at: 0 });
  // 最近一次观测到的「已缓冲到的位置」（buffered.end）与观测时刻。
  // ★ 这才是直播流是否健康的**主判据**：readyState 在 MSE 直播下常态就是 2
  //   （HAVE_CURRENT_DATA），用 readyState < 3 判定「缓冲耗尽」在直播中几乎恒成立，
  //   会把稳定播放持续误判为卡死 —— 这就是「网络明明很好却一直重连」的根因。
  //   buffered.end 持续增长 = 播放器仍在正常收流解码，与网络好坏直接相关。
  const lastBufferedRef = useRef<{ end: number; at: number }>({ end: -1, at: 0 });
  // 看门狗需要读取最新业务状态，用一个 ref 镜像，避免把它塞进 effect 依赖导致定时器反复重建
  const watchdogCtxRef = useRef<{
    loading: boolean;
    offline: boolean;
    hasError: boolean;
    live: boolean | null;
    reconnecting: boolean;
  }>({
    loading: false,
    offline: false,
    hasError: false,
    live: null,
    reconnecting: false
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
    live: playerIsLive,
    reconnecting: reconnectNotice !== null
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

  // ★ 弹幕开关的「实时值」镜像（ref 必须声明在 useState 之前，
  //   否则会构成 TDZ 引用错误）。
  //
  // 弹幕消息监听器是在建播放器时注册一次的，生命周期长于开关的每一次切换。
  // 若监听器直接闭包捕获 isDanmuEnabled，它会永远停留在注册那一刻的值：
  // 进房间时若是关闭状态，用户之后手动打开也依然被判定为「不该显示弹幕」，
  // 所有弹幕在投递前就被丢弃 —— 表现就是「手动打开开关也没有弹幕」。
  // 必须通过 ref 读取最新值，让开关联动立即生效。
  const danmuEnabledRef = useRef(true);

  // ★ 弹幕默认开启：进入直播间一律默认显示弹幕。
  //
  // 原实现从 localStorage 恢复上次的 enabled。问题是这个开关的历史值
  // 可能来自旧版本的各种误操作，一旦被关过一次，之后每次启动都是关闭状态 ——
  // 与「默认开启、只有用户主动关闭才关闭」的产品预期直接冲突。
  // 现在启动态恒为开启；用户手动关闭后本次运行内立即生效（由 ref + overlay 同步），
  // 字号/颜色/透明度等观感设置仍照常持久化。
  const [isDanmuEnabled, setIsDanmuEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    // 用户手动切换过就沿用其选择；否则用默认开启，
    // 待 SettingsProvider hydrate 后由下面的 effect 按 danmuDefaultOn 校正。
    return hasDanmuEnabledOverride() ? loadDanmuPreferences()?.enabled !== false : true;
  });
  /**
   * 用户手动切换弹幕开关的统一入口。
   * 除了 setState，还要落下「用户表达过偏好」这个标记 ——
   * 否则 danmuDefaultOn 会在下次进房时把它覆盖掉，开关等于没记。
   */
  const setIsDanmuEnabled = useCallback((next: boolean) => {
    setIsDanmuEnabledState(next);
    try {
      persistDanmuEnabledOverride(next);
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    danmuEnabledRef.current = isDanmuEnabled;
  }, [isDanmuEnabled]);
  // ★ 记录「本次会话已经启动过弹幕后端」所需的全部参数。
  //   弹幕开关关闭时我们要停掉 Rust 侧的 WebSocket，打开时又要能原样重启，
  //   所以必须把启动参数留存一份；用 ref 是为了不被重建播放器/切房间的中间态污染。
  const danmuBackendCtxRef = useRef<null | {
    sessionId: number;
    platform: Platform;
    backendRoomId: string;
    filterRoomId: string;
  }>(null);
  // 弹幕开关 effect 的首帧跳过标记：首次挂载时后端的启停由
  // mountPlayer → startDanmaku 按开关状态自行决定，不需要这里再插一脚。
  const danmuToggleFirstRunRef = useRef(true);
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
  // 上一次的画质/线路值：用于判断「是否真的发生了用户可见的切换」，
  // 取代旧的布尔闩锁（那玩意会把进房时的默认值同步误判成用户切换）。
  const lastQualityLineRef = useRef<{ quality: string | null; line: string | null }>({
    quality: null,
    line: null
  });
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

  /** 只清「待执行的重连定时器」与画面推进记忆。 */
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    lastProgressRef.current = { time: -1, at: 0 };
  }, []);

  /**
   * 停止卡死看门狗。
   * 注意：看门狗**不**随 destroyPlayer 停止 —— 它必须独立于播放器生命周期存活，
   * 否则「取流失败 → destroyPlayer → 等着重建」这段最需要兜底的空窗期里，
   * 恰好没有任何人在监控重连是否还在推进。只有组件卸载才停它。
   */
  const stopStallWatchdog = useCallback(() => {
    if (stallWatchdogRef.current !== null) {
      window.clearInterval(stallWatchdogRef.current);
      stallWatchdogRef.current = null;
    }
  }, []);

  /**
   * 确认真正恢复：回满重连预算、解除阻断、清掉提示，并开启免打扰期。
   *
   * ★ 与旧实现的关键差异：这里**立即**回满预算并进入免打扰期，
   *   不再要求「连续稳定播放 N 秒」。
   *   旧实现用「画面连续推进满 15 秒」作为回血条件，但直播流的 currentTime
   *   天生会间歇性停住（MSE live-edge 钉住播放头等新数据），于是 healthySince
   *   被反复清零、预算永远回不满，看门狗每 30 秒就判定「重连链条停滞」补一次，
   *   形成无限重连。现在改成「成功即回血 + 20 秒免打扰」，语义与斗鱼/虎牙网页版一致：
   *   一次故障对应一轮重连，期内的小抖动交给播放器内核自愈。
   *
   * ★ 免打扰期是**固定窗口**而非滑动续期：只有「不在免打扰期内」才开启新窗口。
   *   否则内核每自愈成功一次就发 playing、每次都把窗口往后推 20s，
   *   只要流每隔十几秒抖一下就能无限续期 —— 于是应用层重连永远不会启动，
   *   而内核的 disconnectRetryCount 会在这种反复重连中耗尽，最后彻底卡死。
   */
  const commitReconnectHealthy = useCallback(() => {
    const wasRecovering =
      reconnectAttemptRef.current > 0 || reconnectGaveUpRef.current || reconnectDeferredRef.current;
    reconnectAttemptRef.current = 0;
    reconnectBlockedRef.current = false;
    reconnectGaveUpRef.current = false;
    reconnectDeferredRef.current = false;
    reconnectRoundStartRef.current = 0;
    fetchFailStreakRef.current = 0;
    // 固定窗口：已经在免打扰期内就不续期（否则会变成永不结束的滑动窗口）
    if (Date.now() >= reconnectCooldownUntilRef.current) {
      reconnectCooldownUntilRef.current = Date.now() + RECONNECT_COOLDOWN_MS;
    }
    if (wasRecovering) {
      console.info(`[Player] 播放已恢复，${RECONNECT_COOLDOWN_MS / 1000}s 内不再因抖动重连`);
    }
    setReconnectNotice(null);
  }, []);

  /**
   * 观察到画面在推进 / 收到 playing 事件时调用。
   * 只做两件事：清取流失败计数、把恢复时刻推后（滑动式免打扰）。
   * 不在这里回满预算 —— 回预算统一交给 commitReconnectHealthy，
   * 由看门狗在确认「真的在推进」时统一调用，避免多处回血导致状态打架。
   */
  const notePlaybackProgress = useCallback(() => {
    // 画面能推进 = 流确实拿到了，取流失败连击清零
    fetchFailStreakRef.current = 0;
  }, []);

  /**
   * 触发一次自动重连（指数退避 3s→6s→12s→20s→30s→45s）。
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
    // 已经用尽重连次数并把控制权交还用户 —— 在用户手动重载之前不再自作主张
    if (reconnectGaveUpRef.current) return;
    if (reconnectTimerRef.current !== null) return; // 已有待执行的重连，避免叠加

    // ===== 免打扰期：刚恢复播放的一段时间内，任何抖动都不再触发新重连 =====
    // 这道闸门是「网络稳定却一直重连」和「重连一次后无限重连」的直接解药。
    // 直播流天生会间歇性卡顿（编码器/GOP/网络抖动/MSE 缓冲），播放器内核本来就能自愈，
    // 应用层不该在这些抖动上反复重连 —— 那只会把好端端的流反复重建，
    // 越重连越卡，最终卡死在「重播」。
    // ★ 但这里必须**暂存**而不是直接丢弃：若窗口期内真的断了一次流，
    //   直接 return 就再也没人会发起这次重连了（内核 error 被吞、看门狗又在窗口内躺平），
    //   结果是永久黑屏、只能手动刷新。暂存后由看门狗在窗口到期时捡起来补排。
    if (Date.now() < reconnectCooldownUntilRef.current) {
      reconnectDeferredRef.current = true;
      return;
    }

    if (reloadInFlightRef.current) {
      // ★ 这里曾经直接 return —— 那是「自动重连两次后就一直转圈」的关键一环：
      //   播放器的 error 事件经 setTimeout(0) 延后一拍触发，但一次 reloadStream 的
      //   await 链（弹幕停止 IPC、取流网络请求、动态 import、重建播放器）远超一个宏任务，
      //   于是这次重连请求被守卫静默吞掉，之后没有任何人再发起下一次 —— 链条当场断裂。
      //   现在改为记下请求，等本次取流结束后由 finally 补偿调度。
      reconnectDeferredRef.current = true;
      return;
    }

    const attempt = reconnectAttemptRef.current;
    const now = Date.now();

    // ===== 退避总时长封顶 =====
    // 退避总和已 116s，加上每次重建耗时，4 分钟足够覆盖各种慢场景。
    // 超过这个时长说明已经不是「网络瞬断」，果断停止并交还控制权给用户——
    // 否则在持续弱网下会一轮接一轮地重连下去，用户眼里就是「无限重连」。
    if (reconnectRoundStartRef.current > 0 && now - reconnectRoundStartRef.current > RECONNECT_ROUND_WINDOW_MS) {
      console.warn("[Player] 本轮自动重连超过总时长上限，停止自动重连");
      reconnectGaveUpRef.current = true;
      reconnectAttemptRef.current = 0;
      reconnectRoundStartRef.current = 0;
      reconnectDeferredRef.current = false;
      setReconnectNotice(null);
      setStreamError(
        `网络连接中断，自动重连持续超过 ${Math.round(
          RECONNECT_ROUND_WINDOW_MS / 60000
        )} 分钟仍未恢复。\n请检查网络连接后点击「再试一次」。`
      );
      return;
    }

    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      // 次数用尽：停止自动重连，给出明确出口（错误页 + 「再试一次」按钮）。
      // 必须置 gaveUp 标志并把计数归零，否则看门狗会把「已达上限」也当成
      // 「重连链条停滞」而反复补调度，陷入无意义的重试循环。
      reconnectGaveUpRef.current = true;
      reconnectAttemptRef.current = 0;
      reconnectRoundStartRef.current = 0;
      reconnectDeferredRef.current = false;
      setReconnectNotice(null);
      setStreamError(
        `网络连接中断，已自动重连 ${RECONNECT_MAX_ATTEMPTS} 次仍未成功。\n请检查网络连接后点击「再试一次」。`
      );
      return;
    }

    // 本轮重连的第一枪：记下起始时刻，作为总时长封顶的基准
    if (reconnectRoundStartRef.current === 0) reconnectRoundStartRef.current = now;

    reconnectAttemptRef.current = attempt + 1;
    const seq = attempt + 1;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
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
   * 卡死看门狗：每 3 秒一跳，承担两个职责。
   *
   * 职责一（重连活性巡检）—— 兜住「重连链条静默断裂」：
   *   只要处于重连流程（取流中或有待执行的退避定时器），就检查它是否真的在推进。
   *   挂死的 await 会被硬超时强制解锁。这是「自动重连两次后就一直转圈」的根治手段。
   *
   * 职责二（断流检测）—— 兜住「播放器没抛 error、但流其实已经断了」：
   *   弱网丢包时很常见，只监听 error 事件会漏掉这一类。
   *
   * ★★★ 这是「网络稳定却一直触发重连」的**真正根因**，判据在此彻底换掉：
   *
   *   旧判据：currentTime 不推进 + (readyState < 3) → 判假死 → 重连
   *   ① currentTime 在直播中**合法地**长时间不推进：主播画面静止（静态画面/未动）
   *      时编码器几乎不吐新帧；MSE 为追 live-edge 还会主动把播放头钉在缓冲末尾等新数据。
   *      这两种情况在网络完美的机器上一样会发生。
   *   ② readyState < 3 在 MSE 直播里**几乎恒成立**。readyState 描述的是
   *      「当前可播数据的充足程度」，而 MSE 为了压低延迟会持续把已播过的缓冲区
   *      回收掉，直播的 readyState 常态就是 2(HAVE_CURRENT_DATA)、偶尔 1。
   *      所以这一条根本没有区分能力 —— 等于把判据退化成「只看画面动不动」。
   *      两者一叠加，**稳定播放被判成卡死，然后触发重连**；重连又重建播放器，
   *      进一步加剧卡顿，于是用户看到的就是「网络好得很却一直在重连」。
   *
   *   新判据（唯一信号）：**buffered.end() 是否还在增长**。
   *   只要播放器还在往 SourceBuffer 里塞数据，就说明收流、解码、播放链路全通，
   *   哪怕画面此刻完全静止也绝不能重连。只有「缓冲停止增长 + 播放头也不动」
   *   持续 STALL_STUCK_MS，才是真的断流。
   *
   *   附带好处：流被限速/卡顿时 buffered 增长会变慢但不会停，
   *   于是「慢但活着」与「死了」被正确区分开了。
   */
  const startStallWatchdog = useCallback(() => {
    if (stallWatchdogRef.current !== null) return;
    lastProgressRef.current = { time: -1, at: 0 };
    lastBufferedRef.current = { end: -1, at: 0 };
    stallWatchdogRef.current = window.setInterval(() => {
      if (disposedRef.current) return;
      const now = Date.now();
      const ctx = watchdogCtxRef.current;

      // 读取 <video> 与「已缓冲到的位置」（下面所有判定都要用）
      let video: HTMLVideoElement | null = null;
      try {
        const root = playerRef.current?.root as HTMLElement | null;
        video = (root?.querySelector("video") as HTMLVideoElement) ?? null;
      } catch {
        video = null;
      }
      // ★ buffered.end(最后一段) = 播放器目前已收到的最靠前的时间点。
      //   它持续增长 = 还在正常收流。这与网络好坏、直播帧率高低都直接相关，
      //   是唯一不含歧义的健康信号。取不到时返回 -1 表示「本轮无观测」。
      let bufferedEnd = -1;
      try {
        if (video && video.buffered && video.buffered.length > 0) {
          bufferedEnd = video.buffered.end(video.buffered.length - 1);
        }
      } catch {
        bufferedEnd = -1;
      }

      // ===== 免打扰期到期：补排被暂存的重连请求 =====
      // 免打扰期内到达的故障请求只置 deferred 不排定时器（见 scheduleReconnect）。
      //
      // ★ 补排前**必须**重新确认一次流是不是真的死了。
      //   免打扰期内那次「故障」很可能只是内核自愈过程中抛出的一次 error，
      //   而内核随后已经自己恢复了（缓冲一直在涨、画面在播）。
      //   旧实现不检查就补排 → 每次内核自愈都会在 20s 后引发一次完整重取流，
      //   这正是「网络稳定却持续重连」的第二条独立路径：
      //   内核重试 → error → 暂存 → 20s 后无条件补排 → 重建播放器 → 又抖一下 → 循环。
      const deferredDue =
        reconnectDeferredRef.current &&
        now >= reconnectCooldownUntilRef.current &&
        !reloadInFlightRef.current &&
        reconnectTimerRef.current === null;
      if (deferredDue) {
        // 判定「现在是否真的健康」：缓冲在增长，或画面在推进，都说明已恢复。
        const bPrev = lastBufferedRef.current;
        const stillInflowing = bufferedEnd >= 0 && bufferedEnd > bPrev.end;
        const pPrev = lastProgressRef.current;
        const frameMoving =
          !!video && !video.paused && !video.ended && video.currentTime !== pPrev.time;
        if (stillInflowing || frameMoving) {
          // 已恢复：丢弃这次暂存的故障请求，绝不重连。
          reconnectDeferredRef.current = false;
          lastBufferedRef.current = { end: bufferedEnd, at: now };
          lastProgressRef.current = { time: video?.currentTime ?? -1, at: now };
          commitReconnectHealthy();
          return;
        }
        reconnectDeferredRef.current = false;
        console.info("[Player] 免打扰期结束，确认流仍无数据流入，补排重连");
        scheduleReconnect("免打扰期结束补排");
        return;
      }

      // ===== 职责一：重连活性巡检 =====
      // 「重连进行中」认两件事：有取流在跑，或有待执行的退避定时器。
      // （免打扰期内暂存的 deferred 已在上面单独处理，这里不重复计入）
      const reconnectRunning = reloadInFlightRef.current || reconnectTimerRef.current !== null;
      if (reconnectRunning) {
        // 取流 / 重建挂死：超过硬超时一律判定为死锁，作废该会话并重排重连。
        // 没有这一步，一个永不返回的 await 就能把 reloadInFlightRef 永久钉在 true，
        // 之后所有重连请求都被守卫吞掉 —— 那正是用户看到的「一直转圈」。
        if (reloadInFlightRef.current && now - reloadStartedAtRef.current > RELOAD_HARD_TIMEOUT_MS) {
          console.warn("[Player] 取流/重建超过硬超时，判定为挂死：作废该会话并重排重连");
          reloadInFlightRef.current = false;
          pendingReloadRef.current = null;
          activeSessionIdRef.current = ++sessionSeqRef.current; // 让挂死的旧会话彻底作废，避免它稍后回魂
          setIsLoadingStream(false);
          scheduleReconnect("取流超时");
        }
        // 此时 loading 必然为真、画面本来就该静止 —— 不做断流判定
        return;
      }

      const playing = !!video && !video.paused && !video.ended;
      const prev = lastProgressRef.current;
      const bCur = lastBufferedRef.current;

      // ===== 职责二：断流判定 =====
      // 加载中 / 已报错 / 主播未开播：不判定，避免误伤
      if (ctx.loading || ctx.hasError || ctx.offline) return;
      if (!video) return;
      // 用户主动暂停：绝不能判成断流（这是最容易被误伤的情况）
      if (userPausedRef.current) return;
      // 窗口关到托盘：后台照常播放，但 Chromium 会节流定时器与解码，
      // 此时的「缓冲不增长」多半是节流而非断流，一律不判故障。
      if (windowHiddenRef.current) {
        lastProgressRef.current = { time: video.currentTime, at: now };
        lastBufferedRef.current = { end: bufferedEnd, at: now };
        // ★ 后台保活：即便已通过启动参数禁用了后台解码优化，
        //   Chromium 仍可能因为省电策略把不可见窗口的 <video> 置为 paused。
        //   用户在后台既看不到界面也不会去点播放，一旦被暂停就再没人能恢复，
        //   最终演变成「挂一阵回来就解码失败」。这里每 3 秒兜一次。
        //   userPausedRef 已在 pause 事件里做过真伪甄别，
        //   系统自动暂停不会被误记成用户意图而挡住这里。
        if (video.paused && !video.ended && !userPausedRef.current && !ctx.loading) {
          void video.play().catch(() => {});
        }
        // 后台断流兜底：readyState 归零意味着连元数据/首帧都没有，
        // 这是数据链路真的断了。它不会被后台节流误伤 ——
        // 节流只影响解码与渲染节奏，不会把已有的 readyState 打回 0。
        // 没有这一段，后台期间看门狗完全躺平，真断网时用户回到前台
        // 只会看到一个早已死掉的播放器（v0.2.9 的「只能手动刷新」）。
        if (video.readyState === 0) {
          const since = hiddenDeadSinceRef.current || now;
          hiddenDeadSinceRef.current = since;
          if (now - since >= 60000) {
            hiddenDeadSinceRef.current = 0;
            console.warn("[Player] 后台期间数据链路中断超过 60s，自动重连");
            scheduleReconnect("后台数据链路中断");
          }
        } else {
          hiddenDeadSinceRef.current = 0;
        }
        return;
      }
      // 免打扰期内不判断流：刚恢复的流最容易出现「重建缓冲 → 短暂停顿」，
      // 这时触发重连只会把好端端的流又推倒重来（越重连越卡）。
      if (now < reconnectCooldownUntilRef.current) {
        // 窗口内的基准照样推进，避免窗口结束时把「窗口开始前的旧时刻」
        // 当作断流起点而立刻误判
        lastProgressRef.current = { time: video.currentTime, at: now };
        lastBufferedRef.current = { end: bufferedEnd, at: now };
        return;
      }

      // ===== ★ 主判据：缓冲是否仍在增长 =====
      // 还在增长 = 收流解码链路全通 = 一切正常，哪怕画面完全静止。
      if (bufferedEnd >= 0) {
        if (bufferedEnd > bCur.end) {
          // 有新数据到达 → 健康。顺带回满重连预算并开启免打扰期。
          lastBufferedRef.current = { end: bufferedEnd, at: now };
          lastProgressRef.current = { time: video.currentTime, at: now };
          notePlaybackProgress();
          if (reconnectAttemptRef.current > 0 || ctx.reconnecting) {
            commitReconnectHealthy();
          }
          return;
        }
        // 缓冲一点没涨。直播流在极低帧率/静止画面下 buffered 可能长时间不动，
        // 所以必须再叠加「播放头也完全不动」才判死，且要给足 30s。
        if (playing && video.currentTime !== prev.time) {
          // 画面在动但缓冲没涨：还在播（可能是本地解码追上了缓冲末尾），
          // 同样视为健康，只是不回血（避免反复开免打扰窗口掩盖真问题）。
          lastProgressRef.current = { time: video.currentTime, at: now };
          lastBufferedRef.current = { end: bufferedEnd, at: now };
          return;
        }
        // 缓冲不涨 + 画面不动 → 累计静止时长
        const stillSince = bCur.at || now;
        if (now - stillSince >= STALL_STUCK_MS) {
          console.warn(
            `[Player] 缓冲与播放头均无变化超过 ${STALL_STUCK_MS / 1000}s，判定断流`
          );
          lastBufferedRef.current = { end: bufferedEnd, at: now };
          lastProgressRef.current = { time: video.currentTime, at: now };
          scheduleReconnect("画面断流");
        }
        return;
      }

      // ===== 兜底：完全取不到 buffered（某些环境 buffered.length 恒为 0）=====
      // 这时退回到「播放头不动 + video 处于 waiting/暂停」的弱判据，
      // 并用更宽松的 45s，避免在信息缺失时轻率重连。
      if (playing && video.currentTime !== prev.time) {
        lastProgressRef.current = { time: video.currentTime, at: now };
        notePlaybackProgress();
        return;
      }
      const prev2 = lastProgressRef.current;
      const stillSince2 = prev2.at || now;
      if (now - stillSince2 >= 45000) {
        lastProgressRef.current = { time: video.currentTime, at: now };
        scheduleReconnect("画面无推进");
      }
    }, STALL_CHECK_INTERVAL_MS);
  }, [commitReconnectHealthy, notePlaybackProgress, scheduleReconnect]);

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
    // 切房间/切画质/销毁时，停掉挂起的自动重连定时器，
    // 避免旧会话的定时器在新会话里误触发一次重连。
    // 注意一：这里刻意不重置 reconnectAttemptRef —— 自动重连内部也会经过 destroyPlayer，
    //   若在此清零，退避计数永远归零，会退化成无限重连。
    // 注意二：这里刻意**不**停卡死看门狗 —— 它必须跨「取流失败 → 重建」这段空窗期存活，
    //   否则自动重连挂死时就没有任何人在兜底（那正是「一直转圈」能无限持续的成因之一）。
    //   看门狗只在组件卸载时由 stopStallWatchdog() 停止。
    clearReconnectTimer();

    clearDanmakuListeners();

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

    // 自动重连触发的重建要保留全屏态：断网重连时把用户踢出全屏是很糟的体验。
    // 用模式标记而不是参数，是因为自动重连路径上 destroyPlayer 的调用点很多
    // （各平台分支的失败回退、catch 兜底），逐个传参会漏。
    if (!autoReconnectModeRef.current) setIsFullScreen(false);
  }, [clearReconnectTimer, clearDanmakuListeners]);

  const stopAllDanmakuBackends = useCallback(async () => {
    // Business rule: only one room at a time. Stopping all backends is the safest way to avoid cross-platform leaks.
    //
    // ★ 并行 + 逐个超时兜底（原来是串行 await 五个）：
    //   这五个 stop 互不依赖，串行执行时耗时累加（每个几百 ms 就很可观），
    //   更糟的是任何一个挂住就会把整条重连链钉死。改成 Promise.all 后总耗时
    //   取决于最慢的那一个，且每个都有独立超时上限。
    await Promise.all(
      [
        invokeWithTimeout(invoke("stop_danmaku_listener", { roomId: "" }), "stop_danmaku_listener"),
        invokeWithTimeout(invoke("stop_douyin_danmu_listener"), "stop_douyin_danmu_listener"),
        invokeWithTimeout(invoke("stop_huya_danmaku_listener", { roomId: "" }), "stop_huya_danmaku_listener"),
        invokeWithTimeout(invoke("stop_bilibili_danmaku_listener"), "stop_bilibili_danmaku_listener"),
        invokeWithTimeout(invoke("stop_twitch_danmaku_listener", { roomId: "" }), "stop_twitch_danmaku_listener")
      ].map((p) => p.catch(() => undefined))
    );
  }, []);

  const stopAllProxies = useCallback(async () => {
    // Only one room at a time; stop both to avoid "switch platform" leaks.
    // 同上：并行 + 超时兜底，避免停代理挂住整条重连链。
    await Promise.all(
      [
        invokeWithTimeout(stopDouyuProxy(), "stopDouyuProxy"),
        invokeWithTimeout(stopHuyaProxy(), "stopHuyaProxy")
      ].map((p) => p.catch(() => undefined))
    );
  }, []);

  // 记录「真实用户操作」的时刻，供 player.on("pause") 区分
  // 用户主动暂停 与 系统/内核自动暂停（详见该处的注释）。
  // 用捕获阶段监听：xgplayer 自己的控件可能会 stopPropagation，
  // 捕获阶段能保证这类点击同样被记到。
  useEffect(() => {
    const mark = () => {
      lastUserInputAtRef.current = Date.now();
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("keydown", mark, true);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("keydown", mark, true);
    };
  }, []);

  // 关窗到托盘 → 继续播放（不停弹幕、不停代理）；再次唤起 → 什么都不用做。
  //
  // ★ v0.2.7 的旧行为已按用户要求推翻：那时 Rust hide 之后前端会
  //   video.pause() + stopAllDanmakuBackends() + stopAllProxies()，
  //   结果就是「只要 DTV_X 放在后台就不播了」。现在整条播放链路
  //   （本地代理转发 + MSE 解码 + 弹幕）在后台完整保留，
  //   只有用户真正退出应用时才随进程一起结束。
  //
  // 唤回时也**不做**任何恢复动作：既然什么都没停，就没有东西需要恢复。
  // ★ 特别不要在这里调 reloadStream —— 那是 v0.2.7 的补丁（因为代理被停了
  //   才必须重新取流），现在这个前提不成立了，重取流只会白白重建播放器，
  //   在用户眼前造成一次莫名其妙的重新加载。
  //
  // 唯一保留的动作：标记 windowHiddenRef，供看门狗在后台期间不判故障。
  useEffect(() => {
    let unlistenHidden: (() => void) | null = null;
    let unlistenShown: (() => void) | null = null;
    let disposed = false;

    const setup = async () => {
      try {
        const un1 = await listen("main-window-hidden", () => {
          if (disposed) return;
          // 只置标记：后台照常播放，弹幕与代理一律不动。
          windowHiddenRef.current = true;
        });
        const un2 = await listen("main-window-shown", () => {
          if (disposed) return;
          windowHiddenRef.current = false;
          // 把进度基准推到当前时刻，避免窗口刚回来时残留的旧时间戳
          // 被当成「已经卡了很久」而立刻误判一次假死。
          lastProgressRef.current = { time: -1, at: Date.now() };
          lastBufferedRef.current = { end: -1, at: Date.now() };

          let video: HTMLVideoElement | undefined;
          try {
            video = (playerRef.current as any)?.video as HTMLVideoElement | undefined;
          } catch {
            video = undefined;
          }

          // ★ 唤回自愈：后台期间这条流可能已经被判死（错误页 / 自动重连次数用尽 /
          //   video.error 已置位）。用户回到前台应该直接看到恢复好的画面，
          //   而不是盖着一层「解码失败」还得手动点刷新 —— 那正是 v0.2.9 的表现。
          // 主播确实未开播（blocked）的情况排除在外：此时重载只会再撞一次未开播。
          const dead =
            !reconnectBlockedRef.current &&
            (reconnectGaveUpRef.current || watchdogCtxRef.current.hasError || !!video?.error);
          if (dead) {
            console.info("[Player] 窗口唤回时检测到播放已中断，自动重新取流恢复");
            // 解除「已放弃自动重连」的封印，让这一轮能真正跑起来
            reconnectGaveUpRef.current = false;
            reconnectAttemptRef.current = 0;
            reconnectRoundStartRef.current = 0;
            reconnectDeferredRef.current = false;
            reconnectCooldownUntilRef.current = 0;
            fetchFailStreakRef.current = 0;
            setStreamError(null);
            setIsOfflineError(false);
            void reloadStreamRef.current?.("refresh");
            return;
          }

          // 正常情况：Chromium 可能在隐藏期间自动暂停了媒体，兜底恢复一次；
          // 本来就在播的视频完全不受影响。
          try {
            if (video && video.paused && !video.ended && !userPausedRef.current) {
              void video.play().catch(() => {});
            }
          } catch {
            // ignore
          }
        });
        if (disposed) {
          un1();
          un2();
          return;
        }
        unlistenHidden = un1;
        unlistenShown = un2;
      } catch {
        // 非 tauri 环境：忽略
      }
    };
    void setup();

    return () => {
      disposed = true;
      try { unlistenHidden?.(); } catch { /* ignore */ }
      try { unlistenShown?.(); } catch { /* ignore */ }
    };
  }, []);

  const startDanmaku = useCallback(
    async (
      sessionId: number,
      overlay: DanmuOverlayInstance | null,
      platformToStart: Platform,
      roomIdToStart: string,
      roomIdToFilter?: string
    ) => {
      clearDanmakuListeners();

       if (!roomIdToStart) return;
       if (!isSessionActive(sessionId)) return;

       // ★ 弹幕开关关闭时根本不启动底层 WebSocket。
       //   旧实现是「先无条件起 5 个平台的 WS + 心跳，再在投递前用 ref 拦掉」，
       //   结果是：关掉弹幕后，5 条 WebSocket 仍在收包、仍在解码、仍逐条跨进程
       //   emit danmaku-message 到前端（被 :1488 的判断丢掉），CPU/网络/内存
       //   全都白付，唯一效果只是「看不见」。
       //   这里提前返回，让开关真正决定底层资源的有无。
       //   注意必须读 danmuEnabledRef：startDanmaku 的闭包里 isDanmuEnabled
       //   只在 useCallback 重建那一刻准确，而本函数正是被该依赖驱动重建的，
       //   直接用 ref 最保险，也顺手去掉 startDanmaku 对 isDanmuEnabled 的依赖。
       if (!danmuEnabledRef.current) {
         danmuBackendCtxRef.current = null;
         return;
       }

       // 记下启动上下文：关闭开关时要靠它停后端，打开时要靠它原样重启。
       danmuBackendCtxRef.current = {
         sessionId,
         platform: platformToStart,
         backendRoomId: roomIdToStart,
         filterRoomId: roomIdToFilter || roomIdToStart
       };

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

        // ★ 必须读 ref 而不是闭包里的 isDanmuEnabled：
        //   监听器注册后不会随开关切换重新注册，闭包值会永远停在注册那一刻，
        //   导致「手动打开开关后仍然一条弹幕都没有」。
        if (danmuEnabledRef.current && overlay?.sendComment) {
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

      // ★ 入集合前必须再确认一次会话仍然有效。
      //   上面这一串 await（stopAllDanmakuBackends → start_*_listener → listen）
      //   让出了好几次事件循环，期间完全可能发生「用户点刷新抢占并启动了新会话」。
      //   若不检查就入集合，这个已被废弃的监听器会一直留在 Set 里，
      //   持续接收所有平台的 danmaku-message、持续占用 overlay 引用。
      if (!isSessionActive(sessionId)) {
        try {
          unlisten();
        } catch {
          // ignore
        }
        return;
      }
      unlistenRef.current.add(unlisten);
    },
    [isSessionActive, stopAllDanmakuBackends, clearDanmakuListeners]
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
          loadTimeout: 15000, // 请求超时。默认 10000ms 在国内网络下偏紧，容易误报
          // ★★30s 而非默认的 5000ms —— 这是「网络稳定却触发重连」的第二个独立根因。
          // maxReaderInterval 的语义是「连续多少毫秒收不到数据判定为断流」。
          // 直播流天然会长时间收不到数据：
          //   · 主播画面静止时编码器可能好几秒不吐新帧；
          //   · 弹幕/礼物特效期间部分流会有瞬时停顿；
          //   · 弱网抖动一次就轻松超过 5 秒。
          // 一旦内核在 5s 处判定断流，它会先静默重拉（disconnectRetryCount），
          // 而重拉本身又会抛出 error —— 于是应用层每次都收到「故障」信号，
          // 在网络完全正常的情况下反复发起重连，把好端端的流推倒重来。
          // 放宽到 30s 后，内核只对真正的长时间断流才有反应，
          // 短暂抖动完全由它自己无感重拉，用户看不到任何异常。
          maxReaderInterval: 30000
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
          // 免打扰期内不立刻重连：内核的 disconnectRetryCount 重试过程中也会抛 error，
          // 若不拦，内核每重试一次就被应用层判成「故障」→ 疯狂叠加重连。
          // 但要记下 deferred —— 若这次 error 是真断流（而非内核重试），
          // 窗口到期后必须有人补排，否则就是永久黑屏。
          if (Date.now() < reconnectCooldownUntilRef.current) {
            console.info("[Player] 免打扰期内暂缓处理内核错误（优先交给内核自愈）:", detail);
            reconnectDeferredRef.current = true;
            return;
          }
          console.warn("[Player] 播放错误事件，准备自动重连:", err);
          // 延后一拍再调度，尽量避开 reloadStream 的 in-flight 窗口。
          // 即便仍然撞上窗口也不会丢：scheduleReconnect 会转为「补偿调度」，
          // 由该次 reloadStream 的 finally 补上（旧实现是静默丢弃，重连链条会当场断裂）。
          window.setTimeout(() => {
            if (!isSessionActive(sessionId)) return;
            scheduleReconnect(String(detail));
          }, 0);
        });
        // 收到 playing：这次故障已结束，立刻回满重连预算并开启免打扰期。
        // 旧实现在这里只记起始时刻、要等「连续稳定 15 秒」才回血，而直播流的播放头
        // 天生会间歇性停住，那个条件几乎永远不成立 —— 于是预算永远回不满，
        // 看门狗每 30 秒就判定「重连链条停滞」补一次，表现为「重连一次后无限重连」。
        player.on?.("playing", () => {
          if (!isSessionActive(sessionId)) return;
          // 恢复播放 = 用户（或内核自愈）解除了暂停
          userPausedRef.current = false;
          notePlaybackProgress();
          commitReconnectHealthy();
        });
        // ★ 必须区分「用户主动暂停」与「播放器自己卡住」：两者在 video 元素上
        //   都表现为 paused === true，但前者绝不能被判成假死而触发重连。
        //   没有这个标记，看门狗会把用户主动暂停的画面当成断流，反复重连。
        player.on?.("play", () => {
          userPausedRef.current = false;
        });
        player.on?.("pause", () => {
          // ★ 只有紧跟一次真实用户操作（点暂停按钮 / 按空格）的 pause 才算「用户主动暂停」。
          //   下面这些都同样会触发 pause 事件，但都不是用户意图：
          //     · 窗口不可见时 Chromium 的省电/后台视频优化自动暂停
          //     · 缓冲耗尽（waiting）期间内核自己暂停
          //     · 起播阶段 autoplay 被拒
          //   旧实现不加区分一律置 true，后果严重且隐蔽：
          //   后台挂一阵 → Chromium 自动暂停 → 被记成「用户主动暂停」
          //   → 看门狗从此对它彻底躺平、后台保活也被这个标记挡住
          //   → 用户回到前台看到「解码失败」，只能手动点刷新。
          const video = (playerRef.current as any)?.video as HTMLVideoElement | undefined;
          if (!video || video.ended) return;
          userPausedRef.current = Date.now() - lastUserInputAtRef.current < 800;
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
      // ★ 读 ref 而非 state：mountPlayer 是一次性建播放器的动作，
      //   把 isDanmuEnabled 挂成依赖会让「切一下弹幕开关」也重建 mountPlayer
      //   身份，进而让 reloadStream 身份变化（虽然不会自动重取流，但纯属无谓抖动）。
      //   开关的实时值由 danmuEnabledRef 提供，语义上更准确。
      const danmuOnAtMount = danmuEnabledRef.current;
      const overlay = createDanmuOverlay(player, danmuSettings, danmuOnAtMount) as DanmuOverlayInstance | null;
      danmuOverlayRef.current = overlay;
      try {
        applyDanmuOverlayPreferences?.(overlay, danmuSettings, danmuOnAtMount, player.root as any);
        syncDanmuEnabledState(overlay, danmuSettings, danmuOnAtMount, player.root as any);
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
      isSessionActive,
      lineOptions,
      platform,
      roomId,
      startDanmaku,
      // 以下三个均为稳定引用（useCallback 空依赖/单依赖），加入不会造成 mountPlayer 频繁重建
      scheduleReconnect,
      notePlaybackProgress,
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
        // 上一次取流是否已经明显挂死（远超正常耗时却仍未收尾）
        const hung =
          reloadStartedAtRef.current > 0 &&
          Date.now() - reloadStartedAtRef.current > RELOAD_HARD_TIMEOUT_MS;

        if (opts?.isAutoReconnect) {
          if (hung) {
            // ★ 自动重连的「自抢占」。
            //   上一次取流若已挂死，它自己永远走不到 finally，也就永远没人去消费
            //   reconnectDeferredRef —— 旧实现在这里只是记一个标记就 return，
            //   重连链条当场断裂，只能干等看门狗的硬超时来救（期间画面就是一直转圈）。
            //   既然已经确认挂死，就直接抢占，让自动重连也能立刻自救。
            console.warn("[Player] 上次取流已挂死，自动重连强制抢占");
            reloadInFlightRef.current = false;
            pendingReloadRef.current = null;
            // 作废旧会话：避免它稍后「回魂」时把新会话的锁和 loading 误清掉
            activeSessionIdRef.current = ++sessionSeqRef.current;
          } else {
            // 取流中：记下这次重连请求，等本次取流结束后补偿调度（不能丢弃，见 scheduleReconnect 注释）
            reconnectDeferredRef.current = true;
            return;
          }
        } else {
          // 用户手动操作（点刷新 / 切画质 / 切线路）必须**抢占**：
          // 否则一旦某次自动重连的 await 挂死，in-flight 守卫会把用户的手动重载
          // 也一起挡在门外（塞进 pending 而永不消费），用户就只能干看着转圈。
          console.warn("[Player] 用户手动重载抢占进行中的取流会话");
          reloadInFlightRef.current = false;
          pendingReloadRef.current = null;
        }
      }
      reloadInFlightRef.current = true;
      reloadStartedAtRef.current = Date.now();
      const sessionId = ++sessionSeqRef.current;
      activeSessionIdRef.current = sessionId;

      // 非自动重连（切房间/切画质/用户点刷新）视为「重新开始」：重置退避与所有重连相关状态；
      // 自动重连必须保留计数，否则永远到不了上限、会无限重试拖垮自己和服务器。
      if (!opts?.isAutoReconnect) {
        autoReconnectModeRef.current = false;
        reconnectAttemptRef.current = 0;
        reconnectBlockedRef.current = false;
        reconnectGaveUpRef.current = false;
        reconnectDeferredRef.current = false;
        reconnectRoundStartRef.current = 0;
        fetchFailStreakRef.current = 0;
        // 用户主动操作 = 明确表示「我要重新开始」，直接给一段免打扰期。
        // 否则刚点完刷新、播放器还在起播缓冲，抖动就会立刻触发一次自动重连，
        // 把用户的手动操作搅黄（这也是「手动刷新反而变慢」的一个来源）。
        reconnectCooldownUntilRef.current = Date.now() + RECONNECT_COOLDOWN_MS;
        // 切房间/手动刷新后不能继承上一间的暂停态，否则看门狗会一直躺平
        userPausedRef.current = false;
        clearReconnectTimer();
        setReconnectNotice(null);
      }

      setIsLoadingStream(true);
      setStreamError(null);
      setIsOfflineError(false);
      setPlayerIsLive(null);
      setPlayerTitle(null);
      setPlayerAnchorName(null);
      setPlayerAvatar(null);

      // ★ 自动重连必须走「彻底重建」，绝不复用播放器的软切换（switchURL）：
      //   1) 断流恢复场景下，旧实例的 MSE SourceBuffer、flv 内核 reader、重试计数
      //      都已经处于耗尽/异常状态，软切换只是把新 URL 塞进一个已经坏掉的管道；
      //   2) 内核还会因为「新旧地址字符串相同」而把 switchURL 当成空操作
      //      （斗鱼/虎牙短期内取到的地址常常完全一样），于是既不报错也不播放 ——
      //      画面就一直停在转圈上。这正是「自动重连两次后就一直转圈」的直接成因。
      //   提前销毁后，下面各平台的 canSoftSwitch 判定必然为 false，统一走 mountPlayer 全量重建。
      if (opts?.isAutoReconnect) {
        autoReconnectModeRef.current = true; // 让 destroyPlayer 保留全屏态
        // ★ 第一次重连刻意走与「手动点刷新」完全相同的路径 —— 能软切换就软切换。
        //
        //   这是本轮修复的核心。手动刷新是用户反复验证有效的路径，它走的是
        //   player.switchURL()；而之前的自动重连每次都强制 destroyPlayer() + mountPlayer()
        //   彻底重建，等于把已验证有效的那条路主动排除在外，于是出现
        //   「自动重连一直黑屏转圈、手动点一下刷新立刻就好」的怪象。
        //
        //   只有连续失败（第 2 次起）才升级为彻底重建，用它兜住另一种情况：
        //   重取到的流地址与旧地址字符串完全相同，内核会把 switchURL 当成空操作
        //   （既不报错也不播放），这时必须重建才行。
        if (reconnectAttemptRef.current >= 2) {
          destroyPlayer();
        }
      }

      const effectiveQuality = overrides?.quality ?? currentQuality;
      const effectiveLine = typeof overrides?.line !== "undefined" ? overrides.line : currentLine;

      // 每次重载先清掉动态画质列表（Twitch 分支会按取流结果重新填充）
      setQualityOptionsOverride(null);

      // 取流失败且判定为「网络中断」时，不能立刻调用 scheduleReconnect ——
      // 那一刻 reloadInFlightRef 还是 true（函数开头置位、finally 才复位），
      // 会被 scheduleReconnect 的 in-flight 守卫挡掉，导致重连永远不触发。
      // 因此先记下原因，等 finally 复位后再调度。
      let pendingReconnectReason: string | null = null;

      // 注意：以下所有步骤都必须收在 try 里 —— 这里曾经有一条 `if (!isSessionActive) return;`
      // 位于 try **之外**，一旦命中就会跳过 finally：reloadInFlightRef 被永久钉在 true、
      // loading 永久为真，之后每一次重连都被守卫吞掉，画面就一直转圈直到手动刷新。
      try {
        await stopAllDanmakuBackends();
        await stopAllProxies();
        if (!isSessionActive(sessionId)) return;

        try {
          await applyDanmuFontFamilyForOS();
        } catch {
          // ignore
        }

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
        // 自动重连场景下这一步在函数开头已经做过，重复调用无害（此时 playerRef 已是 null）。
        destroyPlayer();
        const msg = e?.message ? String(e.message) : String(e);

        if (isOfflineMessage(msg) || reconnectBlockedRef.current) {
          // 业务层判定：主播确实未开播 / 房间不存在。
          // 显示「主播未开播」并**停止自动重连**，否则会对着已下播的房间反复空转。
          reconnectBlockedRef.current = true;
          reconnectAttemptRef.current = 0;
          reconnectDeferredRef.current = false;
          setReconnectNotice(null);
          setStreamError(maybeAppendHevcInstallHint(msg));
          setIsOfflineError(true);
          setPlayerIsLive(false);
        } else {
          // 网络层中断：取流请求失败，但没有「未开播」特征 —— 大概率只是断网/超时。
          // 关键：绝不能沿用旧的「取流失败一律当作主播未开播」逻辑，
          // 那会在断网时弹出误导性的「主播未开播」，并让自动重连当场失效。
          fetchFailStreakRef.current += 1;
          if (fetchFailStreakRef.current >= FETCH_FAIL_GIVEUP_STREAK) {
            // 连「取流」这一步都连续过不去，说明不是播放中断、而是根本拿不到流
            // （网络中断 / 平台频控 / 接口异常）。继续重连只是对着空气空转，
            // 直接停手并把控制权交还用户，避免用户眼里变成「无限重连」。
            reconnectGaveUpRef.current = true;
            reconnectAttemptRef.current = 0;
            reconnectRoundStartRef.current = 0;
            reconnectDeferredRef.current = false;
            setReconnectNotice(null);
            setStreamError(
              `暂时无法获取直播流（连续 ${fetchFailStreakRef.current} 次取流失败）。\n请检查网络连接后点击「再试一次」。`
            );
            // return 不会跳过 finally，in-flight 锁仍会被正确释放
            return;
          }
          setStreamError(null);
          setIsOfflineError(false);
          pendingReconnectReason = "取流失败";
        }
      } finally {
        autoReconnectModeRef.current = false;
        // 只有自己仍是最新会话时才收尾 —— 被抢占 / 被判挂死作废的旧会话
        // 绝不能把新会话的 in-flight 锁与 loading 状态误清掉。
        const stillCurrent = isSessionActive(sessionId);
        if (stillCurrent) {
          reloadInFlightRef.current = false;
          setIsLoadingStream(false);
        }
        // 网络中断：等 in-flight 守卫复位后再调度重连
        if (stillCurrent && pendingReconnectReason !== null) {
          scheduleReconnect(pendingReconnectReason);
        }
        // 补偿调度：本次取流期间被守卫挡下的重连请求（见 scheduleReconnect 注释）
        const deferred = reconnectDeferredRef.current;
        if (deferred) {
          reconnectDeferredRef.current = false;
          if (stillCurrent && pendingReconnectReason === null) {
            scheduleReconnect("补偿调度");
          }
        }
        if (stillCurrent) {
          const pending = pendingReloadRef.current;
          pendingReloadRef.current = null;
          if (pending) {
            void reloadStream(pending.trigger, pending.overrides, pending.opts);
          }
        }
      }
    },
    [
      clearReconnectTimer,
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
      // 看门狗独立于播放器生命周期，必须在这里显式停掉，否则 interval 会一直空转
      stopStallWatchdog();

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
  }, [destroyPlayer, stopAllDanmakuBackends, stopAllProxies, stopStallWatchdog]);

  useEffect(() => {
    disposedRef.current = false;
    // 看门狗从进房间起就常驻，不依赖播放器是否成功创建：
    // 「一直转圈」的典型场景恰恰是播放器从没建起来、或建到一半挂死，
    // 若只在 mountPlayer 里启动它，这些场景就完全没有兜底。
    startStallWatchdog();
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

  // ★ 弹幕开关真正控制底层资源的有无（双向）。
  //
  // 关闭：解绑前端监听器 + 停掉 Rust 侧全部 5 个平台弹幕 WebSocket 与心跳。
  // 打开：按上次记录的启动上下文原样重启，用户不必刷新房间就能看到弹幕。
  //
  // 为什么必须双向：只做「关闭」会让「打开」变成死开关（后端已停，永远起不来）；
  // 只做「打开」则第一次进房时若开关是关的，startDanmaku 里的提前返回
  // 会让它再也起不来。两个方向都要接上。
  //
  // 幂等保护：startDanmaku 开头会 stopAllDanmakuBackends，所以这里
  // 「先停再启」不会留下重复的 WebSocket。
  useEffect(() => {
    // 首次挂载不做事：那时 startDanmaku/mountPlayer 自己会按开关状态决定。
    const isFirstRunRef = danmuToggleFirstRunRef;
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }

    if (!isDanmuEnabled) {
      // 先解绑：否则停后端期间到达的最后几条消息还会被投进已清空的 overlay。
      clearDanmakuListeners();
      try {
        danmuOverlayRef.current?.clear?.();
      } catch {
        // ignore
      }
      danmuBackendCtxRef.current = null;
      void stopAllDanmakuBackends();
      return;
    }

    // 打开：仅当播放器已经就绪且会话仍然有效时才重启。
    // 若此刻正在取流/切房间，mountPlayer 会用新的上下文正常启动，这里不重复插手。
    const ctx = danmuBackendCtxRef.current;
    if (!ctx || !playerRef.current || reloadInFlightRef.current) return;
    if (!isSessionActive(ctx.sessionId)) return;
    void startDanmaku(
      ctx.sessionId,
      danmuOverlayRef.current,
      ctx.platform,
      ctx.backendRoomId,
      ctx.filterRoomId
    );
  }, [isDanmuEnabled, clearDanmakuListeners, isSessionActive, startDanmaku, stopAllDanmakuBackends]);

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
    //
    // ★ v0.2.13 修复：旧实现用「布尔闩锁」跳过挂载那一次，效果是把
    //   「用户第一次真正切画质」这个动作给吞掉了。
    //   因为进房时的默认值同步（:282 那段把 defaultQuality 写进 state）
    //   也会走这个 effect，而闩锁在更早的空跑里已经被消耗掉，
    //   于是默认值同步 → 触发一次完整 reloadStream → 停弹幕+停代理+重取流+重建播放器，
    //   用户看到的是「刚进房间就自己又加载了一遍」。
    //   现在改成记录上一次的画质/线路值：只有相对上次**真的变了**才重取流。
    const prev = lastQualityLineRef.current;
    if (prev.quality === currentQuality && prev.line === currentLine) return;
    const isFirstSync = prev.quality === null;
    lastQualityLineRef.current = { quality: currentQuality, line: currentLine };
    // 首次同步是「把默认值落到 state」，不是用户操作，不该重取流。
    if (isFirstSync) return;
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
