"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CommonStreamer } from "@/platforms/common/streamerTypes";

export function useBilibiliLiveRooms(subCategoryId: string | null, parentCategoryId: string | null) {
  const [rooms, setRooms] = useState<CommonStreamer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const proxyBaseRef = useRef<string | null>(null);
  // 请求序号：用于丢弃「过期响应」（用户快速切换分类时，旧分类的响应可能晚于新分类到达）
  const requestSeqRef = useRef(0);

  const canFetch = useMemo(() => !!subCategoryId && !!parentCategoryId, [parentCategoryId, subCategoryId]);

  const ensureProxyStarted = useCallback(async () => {
    if (proxyBaseRef.current) return;
    try {
      const base = await invoke<string>("start_static_proxy_server");
      proxyBaseRef.current = base || null;
    } catch (e) {
      console.error("[useBilibiliLiveRooms] Failed to start static proxy server", e);
    }
  }, []);

  const proxify = useCallback((url?: string) => {
    if (!url) return "";
    if (proxyBaseRef.current) return `${proxyBaseRef.current}/image?url=${encodeURIComponent(url)}`;
    return url;
  }, []);

  const mapToCommon = useCallback(
    (raw: any): CommonStreamer => {
      return {
        room_id: String(raw.roomid ?? ""),
        title: raw.title ?? "",
        nickname: raw.uname ?? "",
        avatar: proxify(raw.face ?? ""),
        room_cover: proxify(raw.cover ?? ""),
        viewer_count_str: raw.watched_show?.num != null ? String(raw.watched_show.num) : "",
        platform: "bilibili"
      };
    },
    [proxify]
  );

  const fetchPage = useCallback(
    async (page: number, loadMore: boolean) => {
      if (!subCategoryId || !parentCategoryId) {
        setRooms([]);
        setHasMore(false);
        return;
      }
      // 竞态防护：记录本次请求序号。若响应回来时序号已变（用户切了分类 / 组件已卸载），
      // 说明这是过期响应，必须丢弃 —— 否则旧分类的结果会覆盖或混入新分类的列表。
      const seq = ++requestSeqRef.current;

      await ensureProxyStarted();
      if (loadMore) setIsLoadingMore(true);
      else setIsLoading(true);
      setError(null);

      try {
        const text = await invoke<string>("fetch_bilibili_live_list", {
          areaId: subCategoryId,
          parentAreaId: parentCategoryId,
          page
        });
        if (seq !== requestSeqRef.current) return; // 过期响应，丢弃
        const parsed = JSON.parse(text);
        const list: any[] = parsed?.data?.list ?? [];
        const newRooms = list.map(mapToCommon);
        setRooms((prev) => (loadMore ? [...prev, ...newRooms] : newRooms));
        setHasMore(newRooms.length > 0);
        setCurrentPage(page + 1);
      } catch (e: any) {
        if (seq !== requestSeqRef.current) return; // 过期响应，丢弃
        setError(typeof e === "string" ? e : e?.message || "获取 B 站主播列表失败");
        setHasMore(false);
        if (!loadMore) setRooms([]);
      } finally {
        // 只有「当前有效请求」才允许关闭 loading，避免过期请求把新请求的 loading 状态关掉
        if (seq === requestSeqRef.current) {
          if (loadMore) setIsLoadingMore(false);
          else setIsLoading(false);
        }
      }
    },
    [ensureProxyStarted, mapToCommon, parentCategoryId, subCategoryId]
  );

  const loadInitialRooms = useCallback(async () => {
    setCurrentPage(1);
    setRooms([]);
    setHasMore(true);
    await fetchPage(1, false);
  }, [fetchPage]);

  const loadMoreRooms = useCallback(async () => {
    if (!hasMore || isLoading || isLoadingMore) return;
    await fetchPage(currentPage, true);
  }, [currentPage, fetchPage, hasMore, isLoading, isLoadingMore]);

  useEffect(() => {
    if (!canFetch) {
      setRooms([]);
      setHasMore(false);
      return;
    }
    void loadInitialRooms();
  }, [canFetch, loadInitialRooms]);

  // 卸载后作废所有在途请求，避免组件已卸载仍写入状态
  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
    };
  }, []);

  return { rooms, isLoading, isLoadingMore, error, hasMore, loadInitialRooms, loadMoreRooms };
}

