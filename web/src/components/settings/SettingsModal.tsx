"use client";

// 设置弹窗（参考 dtv_mx 的设置面板结构）：
// 基本设置 / 平台设置 / 平台登录 / 关于（不放检查更新，只放应用简介）。
// 所有设置写入 SettingsProvider（localStorage 持久化，关闭应用再打开依然生效）。
import React, { useEffect, useMemo, useState } from "react";
import { m, AnimatePresence } from "framer-motion";
import { Info, LogIn, LogOut, MonitorSmartphone, Settings as SettingsIcon, SlidersHorizontal, Wrench, X } from "lucide-react";

import { useBilibiliCookie } from "@/platforms/bilibili/useBilibiliCookie";
import { useTheme } from "@/state/theme/ThemeProvider";
import { ALL_PLATFORM_IDS, useAppSettings } from "@/state/settings/SettingsProvider";

import styles from "./SettingsModal.module.css";

const PLATFORM_NAMES: Record<string, string> = {
  douyu: "斗鱼",
  huya: "虎牙",
  douyin: "抖音",
  bilibili: "B站",
  twitch: "Twitch"
};

type SectionId = "basic" | "platform" | "login" | "about";

const SECTIONS: Array<{ id: SectionId; name: string; icon: React.ReactNode }> = [
  { id: "basic", name: "基本设置", icon: <SlidersHorizontal size={16} /> },
  { id: "platform", name: "平台设置", icon: <Wrench size={16} /> },
  { id: "login", name: "平台登录", icon: <LogIn size={16} /> },
  { id: "about", name: "关于", icon: <Info size={16} /> }
];

function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  // 开启态除 CSS 类外，额外用 data-state 属性选择器 + 内联样式双重兜底，
  // 避免被全局主题样式 / 构建期 CSS Modules 处理差异影响，保证"开=蓝色"稳定可见。
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-state={checked ? "checked" : "unchecked"}
      className={`${styles.switch} ${checked ? styles.switchOn : ""} ${disabled ? styles.switchDisabled : ""}`}
      style={
        checked
          ? {
              background: "#4d9fff",
              borderColor: "#4d9fff",
              boxShadow: "0 0 0 3px rgba(77, 159, 255, 0.18)"
            }
          : undefined
      }
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchThumb} style={{ transform: checked ? "translateX(20px)" : "translateX(0)" }} />
    </button>
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("basic");
  const { settings, update } = useAppSettings();
  const theme = useTheme();
  const bilibili = useBilibiliCookie({ autoBootstrap: open });
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (!cancelled) setAppVersion(v || "");
      } catch {
        // 非 Tauri 环境
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const orderedPlatforms = useMemo(() => {
    const order = settings.platformOrder.filter((p) => (ALL_PLATFORM_IDS as readonly string[]).includes(p));
    return order.length ? order : [...ALL_PLATFORM_IDS];
  }, [settings.platformOrder]);

  const movePlatform = (id: string, dir: -1 | 1) => {
    const list = [...orderedPlatforms];
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    update({ platformOrder: list });
  };

  const togglePlatform = (id: string, next: boolean) => {
    update({ enabledPlatforms: { ...settings.enabledPlatforms, [id]: next } });
  };

  return (
    <AnimatePresence>
      {open ? (
        <m.div
          className={styles.backdrop}
          data-tauri-drag-region="false"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <m.div
            className={styles.card}
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ type: "spring", stiffness: 520, damping: 44, mass: 0.7 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className={styles.header}>
              <div className={styles.headerTitle}>
                <SettingsIcon size={18} />
                <span>设置</span>
              </div>
              <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭设置">
                <X size={16} />
              </button>
            </div>

            <div className={styles.body}>
              <div className={styles.sideNav}>
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`${styles.sideItem} ${section === s.id ? styles.sideItemActive : ""}`}
                    onClick={() => setSection(s.id)}
                  >
                    {s.icon}
                    <span>{s.name}</span>
                  </button>
                ))}
              </div>

              <div className={styles.content}>
                {section === "basic" ? (
                  <>
                    <div className={styles.groupTitle}>基本设置</div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>记住栏目</div>
                        <div className={styles.rowDesc}>记住每个平台最后选中的分类，切换平台后自动恢复</div>
                      </div>
                      <Switch
                        checked={settings.rememberCategory}
                        onChange={(v) => update({ rememberCategory: v })}
                      />
                    </div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>默认开启弹幕</div>
                        <div className={styles.rowDesc}>未手动设置过弹幕时，进入直播间默认打开弹幕</div>
                      </div>
                      <Switch
                        checked={settings.danmuDefaultOn}
                        onChange={(v) => update({ danmuDefaultOn: v })}
                      />
                    </div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>默认画质</div>
                        <div className={styles.rowDesc}>未手动选过画质时，新直播间的初始画质</div>
                      </div>
                      <select
                        className={styles.select}
                        value={settings.defaultQuality}
                        onChange={(e) => update({ defaultQuality: e.target.value })}
                      >
                        <option value="原画">原画</option>
                        <option value="高清">高清</option>
                        <option value="标清">标清</option>
                      </select>
                    </div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>屏幕高刷</div>
                        <div className={styles.rowDesc}>开启后跟随系统最高刷新率渲染（高刷屏更流畅）；关闭则界面动画与弹幕锁定 60fps，降低 GPU 占用，视频播放不受影响</div>
                      </div>
                      <Switch
                        checked={settings.highRefreshRate}
                        onChange={(v) => update({ highRefreshRate: v })}
                      />
                    </div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>退出时清理缓存</div>
                        <div className={styles.rowDesc}>开启后每次退出应用自动清理网页缓存、临时文件等垃圾数据；登录状态（如 B站）与设置、关注列表均保留</div>
                      </div>
                      <Switch
                        checked={settings.clearCacheOnExit}
                        onChange={(v) => update({ clearCacheOnExit: v })}
                      />
                    </div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>Twitch 推荐只看中文</div>
                        <div className={styles.rowDesc}>开启后 Twitch「推荐」只显示中文频道，并聚合中文观众常看的谈天说地/IRL；关闭则回到全语言人气总榜。点进具体分类不受影响</div>
                      </div>
                      <Switch
                        checked={settings.twitchZhOnly}
                        onChange={(v) => update({ twitchZhOnly: v })}
                      />
                    </div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>主题模式</div>
                        <div className={styles.rowDesc}>亮色 / 暗色 / 跟随系统</div>
                      </div>
                      <select
                        className={styles.select}
                        value={theme.userPreference}
                        onChange={(e) => theme.setUserPreference(e.target.value as "light" | "dark" | "system")}
                      >
                        <option value="light">亮色</option>
                        <option value="dark">暗色</option>
                        <option value="system">跟随系统</option>
                      </select>
                    </div>
                  </>
                ) : null}

                {section === "platform" ? (
                  <>
                    <div className={styles.groupTitle}>平台启用</div>
                    <div className={styles.groupDesc}>关闭的平台将从顶部导航栏隐藏</div>
                    {orderedPlatforms.map((id: string) => (
                      <div className={styles.row} key={id}>
                        <div className={styles.rowText}>
                          <div className={styles.rowName}>{PLATFORM_NAMES[id] || id}</div>
                        </div>
                        <Switch
                          checked={settings.enabledPlatforms[id] !== false}
                          onChange={(v) => togglePlatform(id, v)}
                        />
                      </div>
                    ))}

                    <div className={styles.groupTitle} style={{ marginTop: 18 }}>
                      平台排序
                    </div>
                    <div className={styles.groupDesc}>设置导航栏中平台的显示顺序</div>
                    {orderedPlatforms.map((id: string, idx: number) => (
                      <div className={styles.row} key={`order_${id}`}>
                        <div className={styles.rowText}>
                          <div className={styles.rowName}>
                            {idx + 1}. {PLATFORM_NAMES[id] || id}
                          </div>
                        </div>
                        <div className={styles.orderBtns}>
                          <button
                            type="button"
                            className={styles.smallBtn}
                            disabled={idx === 0}
                            onClick={() => movePlatform(id, -1)}
                          >
                            上移
                          </button>
                          <button
                            type="button"
                            className={styles.smallBtn}
                            disabled={idx === orderedPlatforms.length - 1}
                            onClick={() => movePlatform(id, 1)}
                          >
                            下移
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                ) : null}

                {section === "login" ? (
                  <>
                    <div className={styles.groupTitle}>平台登录</div>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowName}>哔哩哔哩</div>
                        <div className={styles.rowDesc}>
                          {bilibili.hasRequired
                            ? "已登录（Cookie 有效，可观看高清晰度直播）"
                            : "未登录：高清晰度（如原画）可能受限"}
                          {bilibili.error ? `（${bilibili.error}）` : ""}
                        </div>
                      </div>
                      <div className={styles.orderBtns}>
                        <button
                          type="button"
                          className={styles.smallBtn}
                          disabled={bilibili.isLoggingIn}
                          onClick={() => void bilibili.login()}
                        >
                          {bilibili.isLoggingIn ? "登录中…" : bilibili.hasRequired ? "重新登录" : "登录"}
                        </button>
                        {bilibili.hasRequired ? (
                          <button type="button" className={styles.smallBtn} onClick={() => void bilibili.logout()}>
                            <LogOut size={12} style={{ marginRight: 4 }} />
                            退出
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className={styles.groupDesc} style={{ marginTop: 12 }}>
                      其他平台（斗鱼/虎牙/抖音/Twitch）无需登录即可观看；抖音如需自定义 Cookie 可通过环境变量 DTVX_DOUYIN_COOKIE 注入。
                    </div>
                  </>
                ) : null}

                {section === "about" ? (
                  <>
                    <div className={styles.aboutHead}>
                      <div className={styles.aboutIcon}>
                        <MonitorSmartphone size={34} />
                      </div>
                      <div className={styles.aboutName}>DTV_X</div>
                      <div className={styles.aboutVersion}>{appVersion ? `v${appVersion}` : "轻量化直播聚合应用"}</div>
                    </div>
                    <div className={styles.aboutCard}>
                      <div className={styles.groupTitle}>应用简介</div>
                      <p className={styles.aboutText}>
                        轻量化直播聚合应用(exe)：斗鱼、虎牙、抖音、B站、Twitch
                        直播一站式观看，专注看直播。基于 Tauri 2 + WebView2 构建，安装包小、启动快、资源占用低。
                      </p>
                      <ul className={styles.aboutList}>
                        <li>多平台直播聚合：分类自动记忆，订阅分区直达</li>
                        <li>弹幕互动：滚动弹幕 + 弹幕列表，关键词屏蔽</li>
                        <li>关注管理：分组收藏，开播状态一目了然</li>
                        <li>后台挂机不断流，应用内一键检查更新</li>
                        <li>局域网数据同步：配置在设备间迁移</li>
                      </ul>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
