"use client";

// 屏幕高刷开关的运行时效果（对齐 dtv_mx 的 HighRefreshRateEffect）。
//
// Windows 桌面端 WebView2 的渲染帧率始终跟随显示器刷新率，无法像 Android
// 那样切换显示模式；这里实现「关闭高刷」的真实收益：把 requestAnimationFrame
// 全局节流到 ~60fps，让 framer-motion 动画、弹幕渲染等 JS 驱动的重绘从
// 144Hz 降到 60Hz，显著降低 GPU/CPU 占用（视频解码与合成不受影响，播放照常）。
//
// 实现要点：
// - 保存原始 rAF 引用，开关切换时恢复，反复切换无副作用；
// - 节流回调基于原生帧时间戳丢弃多余帧，回调仍拿到真实时间戳，
//   动画时长计算不受影响；
// - cancelAnimationFrame 直接透传原生实现（句柄未变）。
import { useEffect } from "react";

import { useAppSettings } from "@/state/settings/SettingsProvider";

type Raf = (cb: (t: number) => void) => number;

export function HighRefreshRateEffect() {
  const highRefreshRate = useAppSettings().settings.highRefreshRate;

  useEffect(() => {
    const w = window as unknown as {
      requestAnimationFrame: Raf;
      __dtvOriginalRaf?: Raf;
      __dtvThrottledRafActive?: boolean;
    };

    const original = w.__dtvOriginalRaf ?? w.requestAnimationFrame.bind(window);
    w.__dtvOriginalRaf = original;

    if (highRefreshRate) {
      // 开启：恢复原始 rAF（若当前处于节流态）
      if (w.__dtvThrottledRafActive) {
        w.requestAnimationFrame = original;
        w.__dtvThrottledRafActive = false;
      }
      return;
    }

    // 关闭：安装节流版 rAF（60fps 上限）
    if (w.__dtvThrottledRafActive) return;
    let lastTick = 0;
    const MIN_INTERVAL_MS = 15; // ~66fps 上限，兼容 60Hz 屏不丢帧
    const throttled: Raf = (cb) => {
      return original((t) => {
        if (t - lastTick >= MIN_INTERVAL_MS) {
          lastTick = t;
          cb(t);
        } else {
          // 未到节流间隔：继续挂到下一原生帧
          original((t2) => {
            if (t2 - lastTick >= MIN_INTERVAL_MS) {
              lastTick = t2;
              cb(t2);
            } else {
              throttled(cb);
            }
          });
        }
      });
    };
    w.requestAnimationFrame = throttled;
    w.__dtvThrottledRafActive = true;

    return () => {
      // 卸载时兜底恢复（正常卸载路径走开关恢复逻辑）
      if (w.__dtvThrottledRafActive) {
        w.requestAnimationFrame = w.__dtvOriginalRaf ?? w.requestAnimationFrame;
        w.__dtvThrottledRafActive = false;
      }
    };
  }, [highRefreshRate]);

  return null;
}
