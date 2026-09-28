"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CommonStreamer } from "@/platforms/common/streamerTypes";

// Twitch 分区键形态（与 dtv_mx 一致）：
// - "twitch:top"       → 推荐（默认中文热门聚合；zhOnly 关闭时为全语言人气总榜）
// - "twitch:g:<slug>"  → 指定游戏分类（全局热门，游标分页）
export function parseTwitchCategoryKey(key: string | null): { slug: string | null } {
  if (!key) return { slug: null };
  if (key.startsWith("twitch:g:")) {
    const slug = key.slice("twitch:g:".length).trim();
    return { slug: slug || null };
  }
  // twitch:top / 其他 → 推荐流
  return { slug: null };
}

interface TwitchLiveListResponse {
  error: number;
  msg?: string;
  data?: any[];
  cursor?: string | null;
  has_more?: boolean;
}

const PAGE_SIZE = 30;

function mapTwitchItemToCommonStreamer(item: any): CommonStreamer {
  return {
    room_id: item.room_id?.toString() || "",
    title: item.title || "",
    nickname: item.nickname || "",
    avatar: item.avatar || "",
    room_cover: item.room_cover || "",
    viewer_count_str: item.viewer_count_str || "0",
    platform: "twitch"
  };
}

export function useTwitchLiveRooms(categoryKey: string | null, zhOnly: boolean = true) {
  const [rooms, setRooms] = useState<CommonStreamer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<string | null>(null);
  const lastInitialKeyRef = useRef<string | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const { slug } = parseTwitchCategoryKey(categoryKey);

  const fetchPage = useCallback(
    async (loadMore: boolean) => {
      if (inflightRef.current) return inflightRef.current;

      const task = (async () => {
        if (loadMore) setIsLoadingMore(true);
        else setIsLoading(true);
        setError(null);

        try {
          const resp = await invoke<TwitchLiveListResponse>("fetch_twitch_live_list", {
            slug: slug || null,
            cursor: loadMore ? cursorRef.current : null,
            zhOnly: slug ? null : zhOnly
          });
          if (resp.error !== 0) throw new Error(resp.msg || "Twitch 接口返回错误");
          const newRooms = (resp.data ?? []).map(mapTwitchItemToCommonStreamer);
          setRooms((prev) => {
            if (!loadMore) return newRooms;
            const seen = new Set(prev.map((r) => r.room_id));
            const added = newRooms.filter((r) => r.room_id && !seen.has(r.room_id));
            return [...prev, ...added];
          });
          cursorRef.current = resp.cursor ?? cursorRef.current;
          setHasMore(!!resp.has_more && newRooms.length > 0);
        } catch (e: any) {
          console.error("[useTwitchLiveRooms] invoke error", e);
          setError(e?.message || "加载失败");
          if (!loadMore) {
            setRooms([]);
            setHasMore(false);
          }
        } finally {
          if (loadMore) setIsLoadingMore(false);
          else setIsLoading(false);
          inflightRef.current = null;
        }
      })();

      inflightRef.current = task;
      return task;
    },
    [slug, zhOnly]
  );

  const loadInitialRooms = useCallback(async () => {
    cursorRef.current = null;
    setHasMore(true);
    setError(null);
    await fetchPage(false);
  }, [fetchPage]);

  const loadMoreRooms = useCallback(async () => {
    if (!hasMore || isLoading || isLoadingMore) return;
    await fetchPage(true);
  }, [fetchPage, hasMore, isLoading, isLoadingMore]);

  useEffect(() => {
    // 组合键包含 zhOnly：切换「推荐只看中文」后当前列表立即按新设置重载
    const key = `${categoryKey ?? ""}|${slug ? "any" : zhOnly ? "zh" : "all"}`;
    if (lastInitialKeyRef.current === key) return;
    lastInitialKeyRef.current = key;
    cursorRef.current = null;
    setHasMore(true);
    void loadInitialRooms();
  }, [categoryKey, zhOnly, slug, loadInitialRooms]);

  return { rooms, isLoading, isLoadingMore, error, hasMore, loadInitialRooms, loadMoreRooms };
}
