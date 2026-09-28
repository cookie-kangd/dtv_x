import { invoke } from '@tauri-apps/api/core';

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

// 登录窗口由 Rust 侧创建（open_bilibili_login_window），保证 WebView2 browser args
// 与主窗口完全一致 —— JS 端 WebviewWindow 选项不支持 additionalBrowserArgs，
// 且参数不一致时第二个 webview 会创建失败（0x8007139F）。
export interface BilibiliLoginWindowHandle {
  label: string;
}

export const ensureBilibiliLoginWindow = async (): Promise<BilibiliLoginWindowHandle> => {
  await invoke('open_bilibili_login_window');
  return { label: BILIBILI_LOGIN_WINDOW_LABEL };
};

export const bilibiliLoginWindowExists = async (): Promise<boolean> => {
  try {
    return await invoke<boolean>('bilibili_login_window_exists');
  } catch {
    return false;
  }
};

export const closeBilibiliLoginWindow = async (): Promise<void> => {
  try {
    await invoke('close_bilibili_login_window');
  } catch {
    // ignore
  }
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
