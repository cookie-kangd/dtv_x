import { invoke } from '@tauri-apps/api/core';
import type { FollowedStreamer, LiveStatus } from '../common/types';

// This interface should match the DouyuFollowInfo struct returned by Rust
interface DouyuFollowRoomInfo {
  room_id: string;      
  room_name?: string | null; 
  nickname?: string | null;
  avatar_url?: string | null;
  video_loop?: number | null; // Rust i64 maps to number in TS
  show_status?: number | null; // Changed to number
}

// Define what this function returns - it's a partial update for FollowedStreamer
// focusing on the fields this function is responsible for.
interface DouyuRefreshUpdate extends Partial<Omit<FollowedStreamer, 'liveStatus'>> {
  liveStatus: LiveStatus; // Use the common LiveStatus type
}

export async function refreshDouyuFollowedStreamer(
  streamer: FollowedStreamer
): Promise<DouyuRefreshUpdate> {
  try {
    const roomInfo = await invoke<DouyuFollowRoomInfo>('fetch_douyu_room_info', {
      roomId: streamer.id,
    });

    if (roomInfo && roomInfo.room_id === streamer.id) {
      let currentLiveStatus: LiveStatus = 'OFFLINE'; // Default to OFFLINE

      const sStatus = typeof roomInfo.show_status === 'number' ? roomInfo.show_status : null;
      const vLoop = typeof roomInfo.video_loop === 'number' ? roomInfo.video_loop : null;

      // 与 FollowsList 保持一致：show_status === 1 即开播；
      // 仅当明确 video_loop === 1（轮播/回放）时视为未开播。
      // 注意 fetch_douyu_room_info 经常不返回 video_loop 字段，不能因此判为未开播。
      if (sStatus === 1) {
        currentLiveStatus = vLoop === 1 ? 'OFFLINE' : 'LIVE';
      } else {
        currentLiveStatus = 'OFFLINE';
      }

      return {
        liveStatus: currentLiveStatus,
        nickname: roomInfo.nickname ?? streamer.nickname,
        roomTitle: roomInfo.room_name ?? streamer.roomTitle,
        avatarUrl: roomInfo.avatar_url ?? streamer.avatarUrl,
      };
    } else { 
      console.warn(
        `[DouyuFollowHelper] Received data for unexpected room_id or null/undefined data for streamer ${streamer.id}. Expected: ${streamer.id}, Got: ${roomInfo?.room_id}. Full roomInfo:`, 
        roomInfo
      );
      return { liveStatus: 'OFFLINE' }; 
    }
  } catch (e: any) { 
    console.error(
      `[DouyuFollowHelper] Error invoking/processing 'fetch_douyu_room_info' for ${streamer.id}. Error:`, 
      e 
    );
    return { liveStatus: 'UNKNOWN' }; // Or 'OFFLINE' - UNKNOWN signals an error state more clearly
  }
} 