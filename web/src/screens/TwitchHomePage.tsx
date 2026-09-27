"use client";

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { CommonCategory } from "@/components/categories/CommonCategory";
import { CommonStreamerList } from "@/components/streamers/CommonStreamerList";
import type { Category1, CategorySelectedEvent } from "@/platforms/common/categoryTypes";
import { useRememberedCategory } from "@/hooks/useRememberedCategory";

interface TwitchCate {
  slug: string;
  name: string;
}

// Twitch 分类为扁平的游戏列表（数量几十上百），组装为单一 cate1 组 +
// 「推荐」置顶的二级列表，复用 CommonCategory 的展开浮层能力。
function buildTwitchCategories(games: TwitchCate[]): Category1[] {
  return [
    {
      title: "Twitch",
      href: "twitch:root",
      subcategories: [
        { title: "推荐", href: "twitch:top" },
        ...games.map((g) => ({ title: g.name, href: `twitch:g:${g.slug}` }))
      ]
    }
  ];
}

export function TwitchHomePage() {
  const [games, setGames] = useState<TwitchCate[]>([]);
  const remembered = useRememberedCategory("twitch");

  useEffect(() => {
    let mounted = true;
    invoke<TwitchCate[]>("fetch_twitch_categories")
      .then((list) => {
        if (mounted) setGames(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        console.error("[TwitchHomePage] fetch_twitch_categories failed:", e);
        if (mounted) setGames([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const categoriesData = React.useMemo(() => buildTwitchCategories(games), [games]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "transparent" }}>
      <div style={{ flexShrink: 0, background: "transparent", zIndex: 10 }}>
        <CommonCategory
          categoriesData={categoriesData}
          onCategorySelected={(e) => remembered.select(e)}
          initialCate2Href={remembered.initialCate2Href}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", background: "transparent" }}>
        <CommonStreamerList
          selectedCategory={remembered.selected}
          categoriesData={categoriesData}
          platformName="twitch"
        />
      </div>
    </div>
  );
}
