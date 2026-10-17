import { invoke } from '@tauri-apps/api/core';
import { listen, type Event as TauriEvent } from '@tauri-apps/api/event';
import type { Ref } from '../common/ref';
import type { DanmakuMessage, DanmuOverlayInstance, DanmuRenderOptions } from '../../components/player/types';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@/utils/logger';

export interface HuyaUnifiedEntry { quality: string; bitRate: number; url: string; }

let huyaProxyActive = false;

/**
 * v0.3.1：额外返回同画质的全部候选线路地址。
 *
 * 用途：自动重连时前端可以直接 switchURL 秒级换线，不必重新走一遍取流 + 重建播放器
 * （旧实现只把 candidateCount 传了出来，列表本身被丢掉，于是每次「换线」都等价于
 * 一次完整重建，观感就是转圈很久）。
 */
export async function getHuyaStreamConfig(
  roomId: string,
  quality: string = '原画',
  line?: string | null,
  candidateIndex: number = 0,
): Promise<{
  streamUrl: string;
  streamType: string | undefined;
  candidateUrls: string[];
  title?: string | null;
  anchorName?: string | null;
  avatar?: string | null;
  isLive?: boolean | null;
  candidateCount: number;
}> {
  logger.debug('[HuyaPlayerHelper] getHuyaStreamConfig', { roomId, quality, line });
  const MAX_ATTEMPTS = 2; // 最多重试一次

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await invoke<any>('get_huya_unified_cmd', { roomId: roomId, quality, line: line ?? null });
      logger.debug('[HuyaPlayerHelper] getHuyaStreamConfig result', result);

      if (result && result.flv_tx_urls && Array.isArray(result.flv_tx_urls)) {
        if (result.is_live === false) throw new Error('主播未开播');
        // 后端已按画质解析出同画质的全部可用线路，由这里按候选索引挑选；
        // 只有后端没给出候选时才回退到旧的质量表。
        const candidates: string[] = (result.candidate_urls || []).filter(
          (url: unknown) => typeof url === 'string' && url
        );
        const upstreamStreamUrl = candidates.length
          ? candidates[candidateIndex % candidates.length]
          : result.selected_url || pickHuyaUrlByQuality(result.flv_tx_urls, quality) || result.flv_tx_urls[0]?.url;
        if (!upstreamStreamUrl) throw new Error('未获取到有效的虎牙直播流');

        const sanitizedUpstream = upstreamStreamUrl;
        const streamType = inferStreamType(sanitizedUpstream);

        // 对齐 pure_live：虎牙播放需要稳定的 UA/Referer/Origin；WebView 无法给 FLV 请求加自定义 Header，走本地 proxy 注入。
        let finalStreamUrl = sanitizedUpstream;
        try {
          await invoke('set_stream_url_cmd', { url: sanitizedUpstream });
          const proxyUrl = await invoke<string>('start_proxy');
          if (proxyUrl) {
            finalStreamUrl = proxyUrl;
            huyaProxyActive = true;
          }
        } catch {
          // proxy 非关键：失败则回退直连（避免阻断播放），但可能更容易断流
          huyaProxyActive = false;
        }

        return {
          streamUrl: finalStreamUrl,
          streamType,
          candidateUrls: candidates,
          title: result?.title ?? null,
          anchorName: result?.nick ?? null,
          avatar: result?.avatar ?? null,
          isLive: typeof result?.is_live === 'boolean' ? result.is_live : null,
          candidateCount: candidates.length || 1,
        };
      }

      // 数据异常或为空，一般意味着未开播或房间详情获取失败
      throw new Error('获取虎牙房间详情失败');
    } catch (error: any) {
      const msg = String(error?.message || error || '').trim();
      const looksOffline = msg.includes('未开播') || msg.includes('房间不存在') || msg.includes('不存在');

      // 未开播属于正常业务分支：避免刷 error 日志
      if (looksOffline) {
        logger.debug(`[HuyaPlayerHelper] getHuyaStreamConfig offline (attempt ${attempt}/${MAX_ATTEMPTS}): ${msg || 'offline'}`);
      } else {
        logger.error(`[HuyaPlayerHelper] getHuyaStreamConfig error (attempt ${attempt}/${MAX_ATTEMPTS}):`, error);
      }

      if (looksOffline) {
        throw new Error(msg.includes('未开播') ? msg : '主播未开播或无法获取直播流');
      }

      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(msg || '虎牙直播流获取失败');
      }

      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  }

  throw new Error('主播未开播或无法获取直播流');
}

export async function stopHuyaProxy(): Promise<void> {
  if (!huyaProxyActive) return;
  try {
    await invoke('stop_proxy');
  } catch {
    // ignore
  } finally {
    huyaProxyActive = false;
  }
}

// 统一的 Rust 弹幕事件负载（与 Douyin/Douyu 保持一致）
interface UnifiedRustDanmakuPayload {
  room_id: string;
  user: string;
  content: string;
  user_level: number;
  fans_club_level: number;
}
let currentHuyaRoomId: string | null = null;

export async function startHuyaDanmakuListener(
  roomId: string,
  danmuOverlay: DanmuOverlayInstance | null,
  danmakuMessagesRef: Ref<DanmakuMessage[]>,
  renderOptions?: DanmuRenderOptions
): Promise<() => void> {
  logger.debug('[HuyaPlayerHelper] Starting Huya danmaku listener', { roomId });
  currentHuyaRoomId = roomId;
  
  try {
    // 调用后端虎牙弹幕监听命令
    await invoke('start_huya_danmaku_listener', { payload: { args: { room_id_str: roomId } } });
    logger.debug('[HuyaPlayerHelper] Backend Huya danmaku listener started');
  } catch (error) {
    logger.error('[HuyaPlayerHelper] Failed to start backend Huya danmaku listener:', error);
    throw error;
  }

  // 监听弹幕事件
  const eventName = 'danmaku-message';
  
  const unlisten = await listen<UnifiedRustDanmakuPayload>(eventName, (event: TauriEvent<UnifiedRustDanmakuPayload>) => {
    logger.debug('[HuyaPlayerHelper] Received danmaku event', event.payload);
    
    // 只处理当前房间的弹幕（后端 payload 字段为 room_id/user/content/...）
    if (!event.payload || event.payload.room_id !== roomId) {
      return;
    }

    const frontendDanmaku: DanmakuMessage = {
      id: uuidv4(),
      nickname: event.payload.user || '未知用户',
      content: event.payload.content,
      level: String(event.payload.user_level ?? 0),
      badgeLevel: event.payload.fans_club_level != null ? String(event.payload.fans_club_level) : undefined,
      room_id: roomId,
    };

    const shouldDisplay = renderOptions?.shouldDisplay ? renderOptions.shouldDisplay(frontendDanmaku) : true;

    if (shouldDisplay && danmuOverlay?.sendComment) {
      try {
        const commentOptions = renderOptions?.buildCommentOptions?.(frontendDanmaku) ?? {};
        const styleFromOptions = commentOptions.style ?? {};
        const preferredColor = styleFromOptions.color || (frontendDanmaku as any).color || '#FFFFFF';
        danmuOverlay.sendComment({
          id: frontendDanmaku.id,
          txt: frontendDanmaku.content,
          duration: commentOptions.duration ?? 12000,
          mode: commentOptions.mode ?? 'scroll',
          style: {
            ...styleFromOptions,
            color: preferredColor,
          },
        });
      } catch (emitError) {
        logger.warn('[HuyaPlayerHelper] Failed emitting danmu.js comment:', emitError);
      }
    }

    // 添加到弹幕消息列表
    const shouldAppend = renderOptions?.shouldAppendToList ? renderOptions.shouldAppendToList(frontendDanmaku) : true;
    if (shouldAppend) {
      danmakuMessagesRef.value.push(frontendDanmaku);
      if (danmakuMessagesRef.value.length > 200) {
        danmakuMessagesRef.value.splice(0, danmakuMessagesRef.value.length - 200);
      }
    }
  });

  logger.debug('[HuyaPlayerHelper] Event listener registered', { eventName });
  
  return unlisten;
}

export async function stopHuyaDanmaku(currentUnlistenFn: (() => void) | null): Promise<void> {
  if (currentUnlistenFn) {
    try { 
      currentUnlistenFn(); 
      logger.debug('[HuyaPlayerHelper] Event listener unregistered');
    } catch (e) { 
      logger.warn('[HuyaPlayerHelper] stopHuyaDanmaku cleanup error:', e); 
    }
  }
  
  // 停止后端虎牙弹幕监听
  try {
    const roomIdToStop = currentHuyaRoomId || '';
    await invoke('stop_huya_danmaku_listener', { roomId: roomIdToStop });
  } catch (e) {
    logger.warn('[HuyaPlayerHelper] stopHuyaDanmaku: backend stop encountered error (ignored):', e);
  }
  currentHuyaRoomId = null;
  logger.debug('[HuyaPlayerHelper] Huya danmaku stopped');
}

function pickHuyaUrlByQuality(entries: HuyaUnifiedEntry[], quality: string): string | undefined {
  const target = entries.find((e) => e.quality === quality);
  return target?.url;
}

function inferStreamType(url: string): string | undefined {
  if (!url) return undefined;
  if (url.includes('.flv')) {
    return 'flv';
  }
  if (url.includes('.m3u8')) {
    return 'hls';
  }
  return undefined;
}
