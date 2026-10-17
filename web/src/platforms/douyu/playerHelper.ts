import { invoke } from '@tauri-apps/api/core';

let douyuProxyActive = false;

export async function getDouyuStreamConfig(
  roomId: string,
  quality: string = '原画',
  line?: string | null,
  candidateIndex: number = 0,
): Promise<{ streamUrl: string, streamType: string | undefined }> {
  let finalStreamUrl: string | null = null;
  let streamType: string | undefined = undefined;
  const MAX_STREAM_FETCH_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_STREAM_FETCH_ATTEMPTS; attempt++) {
    try {
      const streamUrl = await invoke<string>('get_stream_url_with_quality_cmd', {
        roomId: roomId,
        quality: quality,
        line: line ?? null,
        candidateIndex,
      });
      
      if (streamUrl) {
        // 保留服务端给出的协议：斗鱼直链多为 http，代理层回源不受影响，
        // 强行改成 https 反而会在部分 CDN 上直接连不上。
        finalStreamUrl = streamUrl;
        streamType = 'flv';
        break;
      } else {
        throw new Error('斗鱼直播流地址获取为空。');
      }
    } catch (e: any) {
      const errorMessage = String(e?.message || e || '未知错误');
      console.error(`[DouyuPlayerHelper] 获取斗鱼直播流失败 (尝试 ${attempt}/${MAX_STREAM_FETCH_ATTEMPTS}):`, errorMessage);
      const offlineOrInvalidRoomMessages = [
        '主播未开播',
        '房间不存在',
        'error: 1',
        'error: 102',
        'error code 1',
        'error code 102',
      ];

      const errorMessageLowerCase = errorMessage.toLowerCase();
      const isDefinitivelyOffline = offlineOrInvalidRoomMessages.some(msg => errorMessageLowerCase.includes(msg.toLowerCase()));

      if (isDefinitivelyOffline) {
        console.warn(`[DouyuPlayerHelper] Streamer for room ${roomId} is definitively offline or room is invalid. Aborting retries.`);
        throw e;
      }

      if (attempt === MAX_STREAM_FETCH_ATTEMPTS) {
        throw new Error(`获取斗鱼直播流失败 (尝试 ${MAX_STREAM_FETCH_ATTEMPTS} 次后): ${errorMessage}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); 
    }
  }

  if (!finalStreamUrl) {
    throw new Error('未能获取有效的斗鱼直播流地址。');
  }

  try {
    await invoke('set_stream_url_cmd', { url: finalStreamUrl });
    // 斗鱼直链 300 秒后会被 CDN 主动断开，登记房间信息让代理层在到期前自行续流，
    // 否则播放器每 5 分钟就会停在最后一帧并显示「重播」。
    await invoke('set_stream_renew_cmd', {
      roomId: roomId,
      quality: quality,
      line: line ?? null,
    });
    const proxyUrl = await invoke<string>('start_proxy');
    douyuProxyActive = true;
    return { streamUrl: proxyUrl, streamType };
  } catch (e: any) {
    throw new Error(`设置斗鱼代理失败: ${e.message}`);
  }
}

export async function stopDouyuProxy(): Promise<void> {
  if (!douyuProxyActive) {
    return;
  }
  try {
    await invoke('stop_proxy');
    douyuProxyActive = false;
  } catch (e) {
    console.error('[DouyuPlayerHelper] Error stopping proxy server:', e);
    douyuProxyActive = false;
  }
}
