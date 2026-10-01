"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CommonStreamer } from "@/platforms/common/streamerTypes";
import { logger } from "@/utils/logger";

export function useDouyinLiveRooms(partitionId: string | null, partitionTypeId: string | null) {
  const [rooms, setRooms] = useState<CommonStreamer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentOffset, setCurrentOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const msTokenRef = useRef<string | null>(null);
  // 请求序号：用于丢弃「过期响应」（切换分类时旧分类的响应可能晚于新分类到达）
  const requestSeqRef = useRef(0);

  const canFetch = useMemo(() => !!partitionId && !!partitionTypeId, [partitionId, partitionTypeId]);

  const fetchAndSetMsToken = useCallback(async (): Promise<string | null> => {
    try {
      const token = await invoke<string>("generate_douyin_ms_token");
      msTokenRef.current = token;
      return token;
    } catch (e) {
      console.error("[useDouyinLiveRooms] Failed to fetch msToken:", e);
      setError("Failed to initialize session token.");
      msTokenRef.current = null;
      return null;
    }
  }, []);

  const mapRawRoomToCommonStreamer = useCallback((rawRoom: any): CommonStreamer => {
    const webId = rawRoom.web_rid?.toString?.() || "";
    return {
      room_id: webId || `N/A_RID_${Math.random()}`,
      title: rawRoom.title || "未知标题",
      nickname: rawRoom.owner_nickname || "未知主播",
      avatar: rawRoom.avatar_url || "",
      room_cover: rawRoom.cover_url || "https://via.placeholder.com/320x180.png?text=No+Image",
      viewer_count_str: rawRoom.user_count_str || "0 人",
      platform: "douyin",
      web_id: webId
    };
  }, []);

  const fetchRooms = useCallback(
    async (offset: number, loadMore: boolean, tokenOverride?: string | null) => {
      if (!partitionId || !partitionTypeId) {
        setRooms([]);
        setCurrentOffset(0);
        setHasMore(false);
        setError(null);
        return;
      }

      const msToken = tokenOverride ?? msTokenRef.current;
      if (!msToken) {
        setError("Session token is missing. Please refresh or select category again.");
        setHasMore(false);
        return;
      }

      // 竞态防护：响应回来时若请求序号已变（切换分类 / 组件卸载），丢弃过期响应
      const seq = ++requestSeqRef.current;

      if (loadMore) setIsLoadingMore(true);
      else setIsLoading(true);
      setError(null);

      try {
        logger.debug("[useDouyinLiveRooms] fetch rooms", {
          partition: partitionId,
          partition_type: partitionTypeId,
          offset
        });
        const response = await invoke<any>("fetch_douyin_partition_rooms", {
          partition: partitionId,
          partitionType: partitionTypeId,
          offset,
          msToken: msToken
        });

        if (seq !== requestSeqRef.current) return; // 过期响应，丢弃

        if (response && Array.isArray(response.rooms)) {
          const newRooms = response.rooms.map(mapRawRoomToCommonStreamer);
          setRooms((prev) => (loadMore ? [...prev, ...newRooms] : newRooms));
          setHasMore(Boolean(response.has_more));
          const nextOffset = response.next_offset ?? offset + newRooms.length;
          setCurrentOffset(typeof nextOffset === "string" ? Number(nextOffset) : nextOffset);
        } else {
          logger.warn("[useDouyinLiveRooms] No rooms array in response or invalid structure (expected response.rooms to be an array).");
          if (!loadMore) setRooms([]);
          setHasMore(false);
        }
      } catch (e: any) {
        if (seq !== requestSeqRef.current) return; // 过期响应，丢弃
        logger.error("[useDouyinLiveRooms] Error fetching rooms:", e);
        // 提取更友好的错误信息
        let errorMsg = typeof e === "string" ? e : (e?.message || "Failed to fetch rooms");
        // 如果是抖音 API 的错误，显示更友好的提示
        if (errorMsg.includes("抖音 API 错误") || errorMsg.includes("抖音 API 返回错误")) {
          errorMsg = errorMsg + "\n\n可能原因：\n1. Cookie 已过期，需要更新\n2. 网络环境问题\n3. 抖音 API 限制\n\n请尝试：\n- 重新选择分类\n- 检查网络连接\n- 稍后再试";
          // API 错误时设置 hasMore 为 false，避免无限重试
          setHasMore(false);
        }
        setError(errorMsg);
        if (!loadMore) {
          setRooms([]);
          setHasMore(false);
        }
      } finally {
        // 只有当前有效请求才允许关闭 loading，避免过期请求把新请求的 loading 状态关掉
        if (seq === requestSeqRef.current) {
          if (loadMore) setIsLoadingMore(false);
          else setIsLoading(false);
        }
      }
    },
    [mapRawRoomToCommonStreamer, partitionId, partitionTypeId]
  );

  const loadInitialRooms = useCallback(async () => {
    setCurrentOffset(0);
    setHasMore(true);
    setIsLoading(true);
    setError(null);
    setRooms([]);

    const token = await fetchAndSetMsToken();
    if (!token) {
      setIsLoading(false);
      setHasMore(false);
      return;
    }
    await fetchRooms(0, false, token);
  }, [fetchAndSetMsToken, fetchRooms]);

  const loadMoreRooms = useCallback(async () => {
    if (!hasMore || isLoading || isLoadingMore || !msTokenRef.current) return;
    await fetchRooms(currentOffset, true);
  }, [currentOffset, fetchRooms, hasMore, isLoading, isLoadingMore]);

  useEffect(() => {
    if (!canFetch) {
      setRooms([]);
      setHasMore(false);
      setError(null);
      msTokenRef.current = null;
      return;
    }
    logger.debug("[useDouyinLiveRooms] load initial", { partitionId, partitionTypeId });
    msTokenRef.current = null;
    void loadInitialRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partitionId, partitionTypeId, canFetch]);

  // 卸载后作废所有在途请求，避免组件已卸载仍写入状态
  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
    };
  }, []);

  return { rooms, isLoading, isLoadingMore, error, hasMore, loadInitialRooms, loadMoreRooms };
}
