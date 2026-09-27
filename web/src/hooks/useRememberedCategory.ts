"use client";

// 平台分类记忆（参考 dtv_mx 的「记住栏目」）：
// 每个平台独立记住最后选中的分类；切换到其他平台浏览后回来自动恢复。
// 持久化 key: remembered_category:<platform>，受设置「记住栏目」开关控制。
import { useCallback, useEffect, useRef, useState } from "react";

import type { CategorySelectedEvent } from "@/platforms/common/categoryTypes";
import { readRememberCategoryEnabled } from "@/state/settings/SettingsProvider";

function storageKey(platform: string) {
  return `remembered_category:${platform}`;
}

export function useRememberedCategory(platform: string) {
  const [selected, setSelected] = useState<CategorySelectedEvent | null>(null);
  // 首次恢复的 cate2 href（传给 CommonCategory 做初始选中）
  const [initialCate2Href, setInitialCate2Href] = useState<string | null>(null);
  const rememberRef = useRef<boolean>(true);

  useEffect(() => {
    rememberRef.current = readRememberCategoryEnabled();
    if (!rememberRef.current) return;
    try {
      const raw = window.localStorage.getItem(storageKey(platform));
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<CategorySelectedEvent>;
      if (saved?.cate2Href) {
        setInitialCate2Href(saved.cate2Href);
      }
    } catch {
      // ignore
    }
  }, [platform]);

  const select = useCallback(
    (event: CategorySelectedEvent | null) => {
      setSelected(event);
      if (!event) return;
      if (!rememberRef.current) return;
      try {
        window.localStorage.setItem(
          storageKey(platform),
          JSON.stringify({
            cate1Href: event.cate1Href,
            cate2Href: event.cate2Href,
            cate1Name: event.cate1Name,
            cate2Name: event.cate2Name
          })
        );
      } catch {
        // ignore
      }
    },
    [platform]
  );

  return { selected, select, initialCate2Href };
}
