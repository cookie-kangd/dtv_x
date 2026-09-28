use ::cookie::Cookie;
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl};
use url::Url;

// WebView2 浏览器进程全局共享：同进程内所有 webview 的 browser args 必须与
// tauri.conf.json 主窗口的 additionalBrowserArgs 完全一致，否则创建第二个
// webview 会失败（HRESULT 0x8007139F「组或资源的状态不是执行请求操作的正确状态」）。
// 修改 tauri.conf.json 时必须同步修改这里！
//
// 参数说明（v0.2.2 追加）：
//   --disable-features=CalculateNativeWinOcclusion  Edge 会周期性用 EnumWindows 计算
//       窗口遮挡状态，纯直播场景无收益却很吃 CPU，关掉可降占用。
//   --enable-features=CanvasOopRasterization  画布光栅化放到独立进程，
//       弹幕大量绘制时主 UI 线程更少卡顿。
//   --renderer-process-limit=2  限制渲染进程数上限，降低内存占用。
//   --js-flags=--max-old-space-size=512  限制 V8 老生代堆上限，避免长时间运行后内存膨胀。
const WEBVIEW_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --enable-features=CanvasOopRasterization --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --renderer-process-limit=2 --js-flags=--max-old-space-size=512";

const BILIBILI_LOGIN_WINDOW_LABEL: &str = "bilibili-login";

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BilibiliCookieResult {
    pub cookie: Option<String>,
    pub has_sessdata: bool,
    pub has_bili_jct: bool,
}

fn merge_bilibili_cookies(
    accumulator: &mut BTreeMap<String, String>,
    cookies: Vec<Cookie<'static>>,
) -> (bool, bool) {
    let mut has_sessdata = false;
    let mut has_bili_jct = false;

    for cookie in cookies {
        let name = cookie.name().to_string();
        let domain_matches = cookie
            .domain()
            .map(|d| d.contains("bilibili.com"))
            .unwrap_or_else(|| name.to_ascii_lowercase().contains("bili"));

        if !domain_matches {
            continue;
        }

        let value = cookie.value().to_string();
        if name.eq_ignore_ascii_case("SESSDATA") {
            has_sessdata = true;
        }
        if name.eq_ignore_ascii_case("bili_jct") {
            has_bili_jct = true;
        }

        accumulator.entry(name).or_insert(value);
    }

    (has_sessdata, has_bili_jct)
}

async fn collect_cookie_from_labels(
    app_handle: AppHandle,
    labels: Vec<String>,
    url: String,
) -> Result<BilibiliCookieResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<BilibiliCookieResult, String> {
        let mut collected = BTreeMap::new();
        let mut has_sessdata = false;
        let mut has_bili_jct = false;

        let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

        for label in labels {
            if let Some(window) = app_handle.get_webview_window(&label) {
                if let Ok(cookies) = window.cookies_for_url(parsed_url.clone()) {
                    let (sess, jct) = merge_bilibili_cookies(&mut collected, cookies);
                    has_sessdata |= sess;
                    has_bili_jct |= jct;
                }
                if let Ok(cookies) = window.cookies() {
                    let (sess, jct) = merge_bilibili_cookies(&mut collected, cookies);
                    has_sessdata |= sess;
                    has_bili_jct |= jct;
                }
            }
        }

        let cookie = if collected.is_empty() {
            None
        } else {
            Some(
                collected
                    .into_iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        };

        Ok(BilibiliCookieResult {
            cookie,
            has_sessdata,
            has_bili_jct,
        })
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

fn dedup_labels(mut labels: Vec<String>) -> Vec<String> {
    labels.sort();
    labels.dedup();
    labels
}

#[tauri::command]
pub async fn get_bilibili_cookie(
    app_handle: AppHandle,
    labels: Option<Vec<String>>,
    url: Option<String>,
) -> Result<BilibiliCookieResult, String> {
    let url = url.unwrap_or_else(|| "https://www.bilibili.com/".to_string());
    let label_list = if let Some(list) = labels {
        if list.is_empty() {
            app_handle
                .webview_windows()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        } else {
            list
        }
    } else {
        app_handle
            .webview_windows()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    };

    if label_list.is_empty() {
        return Ok(BilibiliCookieResult::default());
    }

    let labels = dedup_labels(label_list);
    collect_cookie_from_labels(app_handle, labels, url).await
}

#[tauri::command]
pub async fn bootstrap_bilibili_cookie(
    app_handle: AppHandle,
) -> Result<BilibiliCookieResult, String> {
    let label = "bilibili-silent-bootstrap".to_string();
    let url = "https://www.bilibili.com/".to_string();

    if let Some(existing) = app_handle.get_webview_window(&label) {
        let _ = existing.close();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    tauri::WebviewWindowBuilder::new(
        &app_handle,
        label.clone(),
        WebviewUrl::External(parsed_url.clone()),
    )
    .visible(false)
    .resizable(false)
    .focused(false)
    .decorations(false)
    .additional_browser_args(WEBVIEW_BROWSER_ARGS)
    .build()
    .map_err(|e| format!("Failed to open silent window: {}", e))?;

    tokio::time::sleep(Duration::from_secs(3)).await;

    let result =
        collect_cookie_from_labels(app_handle.clone(), vec![label.clone()], url.clone()).await?;

    if let Some(window) = app_handle.get_webview_window(&label) {
        let _ = window.close();
    }

    Ok(result)
}

/// 打开 B 站扫码登录窗口（Rust 侧创建，保证 additional_browser_args 与主窗口一致）。
/// 已存在时仅显示并聚焦。
#[tauri::command]
pub async fn open_bilibili_login_window(app_handle: AppHandle) -> Result<(), String> {
    let url = "https://passport.bilibili.com/login".to_string();
    let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;

    if let Some(existing) = app_handle.get_webview_window(BILIBILI_LOGIN_WINDOW_LABEL) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app_handle,
        BILIBILI_LOGIN_WINDOW_LABEL.to_string(),
        WebviewUrl::External(parsed_url),
    )
    .title("B站登录")
    .inner_size(420.0, 640.0)
    .resizable(true)
    .focused(true)
    .additional_browser_args(WEBVIEW_BROWSER_ARGS)
    .build()
    .map_err(|e| format!("创建登录窗口失败: {}", e))?;

    Ok(())
}

/// 登录窗口是否仍然存在（前端轮询用于检测用户关闭窗口）。
#[tauri::command]
pub async fn bilibili_login_window_exists(app_handle: AppHandle) -> Result<bool, String> {
    Ok(app_handle
        .get_webview_window(BILIBILI_LOGIN_WINDOW_LABEL)
        .is_some())
}

/// 关闭登录窗口（拿到 Cookie 后由前端调用）。
#[tauri::command]
pub async fn close_bilibili_login_window(app_handle: AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(BILIBILI_LOGIN_WINDOW_LABEL) {
        let _ = window.close();
    }
    Ok(())
}
