"use client";

// 平台分类记忆（参考 dtv_mx 的「记住栏目」）：
// 每个平台独立记住最后选中的分类；切换到其他平台浏览后回来自动恢复。
// 持久化 key: remembered_category:<platform>，受设置「记住栏目」开关控制。
import { useCallback, useEffect, useRef, useState } from "react";

import type { CategorySelectedEvent } from "@/platforms/common/categoryTypes";
import { readRememberCategoryEnabled, useAppSettings } from "@/state/settings/SettingsProvider";

function storageKey(platform: string) {
  return `remembered_category:${platform}`;
}

export function useRememberedCategory(platform: string) {
  const [selected, setSelected] = useState<CategorySelectedEvent | null>(null);
  // 首次恢复的 cate2 href（传给 CommonCategory 做初始选中）
  const [initialCate2Href, setInitialCate2Href] = useState<string | null>(null);
  const rememberRef = useRef<boolean>(true);
  // ★ v0.2.13 修复：旧实现绕过 Context 直读 localStorage，且 effect 依赖里
  //   没有 rememberCategory —— 用户在页面上关掉该开关后 rememberRef 仍是旧值 true，
  //   select() 继续往 localStorage 写，表现为「开关关了但还在记」，
  //   必须切平台或重启才生效。改为订阅 Context，开关变化立即同步。
  const { settings } = useAppSettings();

  useEffect(() => {
    const enabled = settings.rememberCategory !== false;
    rememberRef.current = enabled;
    if (!enabled) return;
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
  }, [platform, settings.rememberCategory]);

  const select = useCallback(
    (event: CategorySelectedEvent | null) => {
      setSelected(event);
      if (!event) return;
      // 双保险：ref 是实时镜像，这里再读一次存储，避免任何时序下的陈旧写入。
      if (!rememberRef.current && !readRememberCategoryEnabled()) return;
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
