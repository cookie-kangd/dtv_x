import type { Metadata } from "next";

import "./globals.css";
import { Providers } from "@/components/providers/Providers";
import { AppShell } from "@/components/shell/AppShell";
import { MotionProvider } from "@/components/motion/MotionProvider";
import { TauriIndexHtmlFix } from "@/components/app/TauriIndexHtmlFix";

export const metadata: Metadata = {
  title: "DTV_X",
  description: "DTV_X - Tauri Live Client"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* 首帧主题引导：在 React hydration 之前按 localStorage 设置 data-theme / data-palette，
            避免暗色用户启动时出现一帧白屏（对应上游 4.1.0「启动层内联、首帧即可见」）。
            key 与 ThemeProvider 保持一致；脚本本身无副作用、不访问网络。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var d=document.documentElement;" +
              "var t=localStorage.getItem('theme_preference');" +
              "var dark=t==='dark'||((!t||t==='system')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
              "d.setAttribute('data-theme',dark?'dark':'light');" +
              "var p=localStorage.getItem('theme_palette');if(p)d.setAttribute('data-palette',p);" +
              "}catch(e){}})();"
          }}
        />
        <TauriIndexHtmlFix />
        <Providers>
          <MotionProvider>
            <AppShell>{children}</AppShell>
          </MotionProvider>
        </Providers>
      </body>
    </html>
  );
}
