import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface BilibiliCookieResult {
  cookie: string | null;
  hasSessdata: boolean;
  hasBiliJct: boolean;
}

export const BILIBILI_LOGIN_WINDOW_LABEL = 'bilibili-login';
export const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login';

const normalizeCookieResult = (result: any): BilibiliCookieResult => ({
  cookie: result?.cookie ?? null,
  hasSessdata: Boolean(result?.hasSessdata),
  hasBiliJct: Boolean(result?.hasBiliJct),
});

export const getBilibiliCookies = async (labels?: string[]): Promise<BilibiliCookieResult> => {
  const result = await invoke<BilibiliCookieResult>('get_bilibili_cookie', { labels });
  return normalizeCookieResult(result);
};

export const bootstrapBilibiliCookies = async (): Promise<BilibiliCookieResult> => {
  const result = await invoke<BilibiliCookieResult>('bootstrap_bilibili_cookie');
  return normalizeCookieResult(result);
};

let bootstrapAttempted = false;
let bootstrapPromise: Promise<BilibiliCookieResult> | null = null;
let lastBootstrapResult: BilibiliCookieResult | null = null;

export const ensureBilibiliCookieBootstrap = async (): Promise<BilibiliCookieResult | null> => {
  if (bootstrapAttempted) {
    return lastBootstrapResult;
  }

  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapBilibiliCookies()
      .then((result) => {
        lastBootstrapResult = result;
        bootstrapAttempted = true;
        return result;
      })
      .catch((err) => {
        bootstrapAttempted = true;
        lastBootstrapResult = null;
        throw err;
      })
      .finally(() => {
        bootstrapPromise = null;
      });
  }

  try {
    return await bootstrapPromise;
  } catch (err) {
    console.warn('[BilibiliCookie] Silent bootstrap failed:', err);
    return null;
  }
};

export const ensureBilibiliLoginWindow = async (): Promise<WebviewWindow> => {
  const existing = await WebviewWindow.getByLabel(BILIBILI_LOGIN_WINDOW_LABEL);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
    } catch (e) {
      console.warn('[BilibiliCookie] Failed to focus existing login window:', e);
    }
    return existing;
  }

  // 注意：WebView2 的浏览器进程全局共享，同进程内所有 webview 的 additionalBrowserArgs
  // 必须与主窗口（tauri.conf.json）完全一致，否则第二个 webview 创建会失败
  // （HRESULT 0x8007139F「组或资源的状态不是执行请求操作的正确状态」）。
  const loginWindow = new WebviewWindow(BILIBILI_LOGIN_WINDOW_LABEL, {
    url: BILIBILI_LOGIN_URL,
    title: 'B站登录',
    width: 420,
    height: 640,
    resizable: true,
    focus: true,
    fullscreen: false,
    alwaysOnTop: false,
    additionalBrowserArgs:
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding',
  });

  await Promise.race([
    new Promise<void>((resolve) => {
      loginWindow.once('tauri://created', () => resolve());
    }),
    new Promise<void>((_, reject) => {
      loginWindow.once('tauri://error', (event) => {
        reject(new Error(String(event.payload ?? '创建登录窗口失败')));
      });
    }),
  ]);

  try {
    await loginWindow.show();
    await loginWindow.setFocus();
  } catch (e) {
    console.warn('[BilibiliCookie] Unable to show or focus login window:', e);
  }

  return loginWindow;
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const extractRequiredFlags = (raw: string | null | undefined) => {
  if (!raw) {
    return { hasSessdata: false, hasBiliJct: false };
  }
  const normalized = raw
    .split(';')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  const hasSessdata = normalized.some((segment) => segment.startsWith('sessdata='));
  const hasBiliJct = normalized.some((segment) => segment.startsWith('bili_jct='));

  return { hasSessdata, hasBiliJct };
};

export const hasRequiredCookies = (result: BilibiliCookieResult | null | undefined) => {
  if (!result) return false;
  return Boolean(result.cookie) && result.hasSessdata && result.hasBiliJct;
};
