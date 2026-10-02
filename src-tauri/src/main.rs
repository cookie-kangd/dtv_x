// 在开发模式下允许控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest;
use std::panic;
use std::env;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
// Emitter：app.emit() 是这个 trait 提供的方法，不是 AppHandle 的固有方法，必须显式导入。
// （Manager 提供 get_webview_window / try_state 等；两者都要，别只导一个）
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;
mod logging;
mod cache_cleaner;
mod config_transfer;
mod lan_sync;
mod sync_transfer;
mod platforms;
mod proxy;
mod version_check;
use platforms::common::{
    BilibiliDanmakuState, DouyinDanmakuState, FollowHttpClient, HuyaDanmakuState, TwitchDanmakuState,
};
use platforms::douyin::danmu::signature::generate_douyin_ms_token;
use platforms::douyin::fetch_douyin_partition_rooms;
use platforms::douyin::fetch_douyin_room_info;
use platforms::douyin::fetch_douyin_streamer_info;
use platforms::douyin::{start_douyin_danmu_listener, stop_douyin_danmu_listener};
use platforms::douyin::{get_douyin_live_stream_url, get_douyin_live_stream_url_with_quality};
use platforms::douyu::fetch_categories;
use platforms::douyu::fetch_douyu_room_info;
use platforms::douyu::fetch_three_cate;
use platforms::douyu::{fetch_live_list, fetch_live_list_for_cate3};
use platforms::huya::stop_huya_danmaku_listener;
use platforms::huya::{fetch_huya_live_list, start_huya_danmaku_listener};
// use platforms::huya::get_huya_stream_url_with_quality; // removed in favor of unified cmd

#[derive(Default, Clone)]
pub struct StreamUrlStore {
    pub url: Arc<Mutex<String>>,
}

// State for managing Douyu danmaku listener handles (stop signals)
#[derive(Default, Clone)]
pub struct DouyuDanmakuHandles(Arc<Mutex<Option<oneshot::Sender<()>>>>);

#[tauri::command]
async fn get_stream_url_cmd(room_id: String) -> Result<String, String> {
    // Call the actual function to fetch the stream URL from the new location
    platforms::douyu::get_stream_url(&room_id, None)
        .await
        .map_err(|e| {
            eprintln!(
                "[Rust Error] Failed to get stream URL for room {}: {}",
                room_id,
                e.to_string()
            );
            format!("Failed to get stream URL: {}", e.to_string())
        })
}

#[tauri::command]
async fn get_stream_url_with_quality_cmd(
    room_id: String,
    quality: String,
    line: Option<String>,
) -> Result<String, String> {
    platforms::douyu::get_stream_url_with_quality(&room_id, &quality, line.as_deref())
        .await
        .map_err(|e| {
            eprintln!(
                "[Rust Error] Failed to get stream URL with quality {} for room {}: {}",
                quality,
                room_id,
                e.to_string()
            );
            format!("Failed to get stream URL with quality: {}", e.to_string())
        })
}

// Legacy Huya stream URL command removed in favor of unified command

// This is the command that should be used for setting stream URL if it interacts with StreamUrlStore
#[tauri::command]
async fn set_stream_url_cmd(
    url: String,
    state: tauri::State<'_, StreamUrlStore>,
) -> Result<(), String> {
    let mut current_url = state.url.lock().unwrap();
    *current_url = url;
    Ok(())
}

// Command to start Douyu danmaku listener
#[tauri::command]
async fn start_danmaku_listener(
    room_id: String,
    window: tauri::Window,
    danmaku_handles: tauri::State<'_, DouyuDanmakuHandles>,
) -> Result<(), String> {
    // Business rule: only one room at a time. Always stop any previous listener first.
    let previous_sender = {
        let mut lock = danmaku_handles.0.lock().unwrap();
        lock.take()
    };
    if let Some(sender) = previous_sender {
        let _ = sender.send(());
    }

    let (stop_tx, stop_rx) = oneshot::channel();
    {
        let mut lock = danmaku_handles.0.lock().unwrap();
        *lock = Some(stop_tx);
    }

    let window_clone = window.clone();
    let room_id_clone = room_id.clone();
    tokio::spawn(async move {
        let mut client = platforms::douyu::danmu_start::DanmakuClient::new(
            &room_id_clone,
            window_clone,
            stop_rx, // Pass the receiver part of the oneshot channel
        );
        if let Err(e) = client.start().await {
            eprintln!(
                "[Rust Main] Douyu danmaku client for room {} failed: {}",
                room_id_clone, e
            );
        }
    });

    Ok(())
}

// Command to stop Douyu danmaku listener
#[tauri::command]
async fn stop_danmaku_listener(
    room_id: String,
    danmaku_handles: tauri::State<'_, DouyuDanmakuHandles>,
) -> Result<(), String> {
    // The `room_id` parameter is kept for frontend compatibility.
    // This backend is single-instance, so we always stop the current listener (if any).
    let sender = {
        let mut lock = danmaku_handles.0.lock().unwrap();
        lock.take()
    };
    if let Some(sender) = sender {
        match sender.send(()) {
            Ok(_) => Ok(()),
            Err(_) => Err(format!(
                "Failed to stop Douyu danmaku listener (requested room {}): receiver dropped.",
                room_id
            )),
        }
    } else {
        Ok(())
    }
}

// search_anchor seems fine, assuming douyu::search_anchor is correct
#[tauri::command]
async fn search_anchor(keyword: String) -> Result<String, String> {
    platforms::douyu::perform_anchor_search(&keyword)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_default_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty.".to_string());
    }
    app.opener()
        .open_url(trimmed, None::<String>)
        .map_err(|e| e.to_string())
}

/// 把所有后台弹幕监听/本地代理的停止信号发出去。
/// 进程一旦退出这些任务自然消亡，所以这一步主要是「尽快断开 WebSocket / 释放端口」，
/// 避免退出瞬间还挂着连接、把 WebView2 的 shutdown 拖住（表现为关窗后进程残留在后台）。
fn shutdown_background_tasks(app: &tauri::AppHandle) {
    // 斗鱼用的是 oneshot
    if let Some(state) = app.try_state::<DouyuDanmakuHandles>() {
        let sender = state.0.lock().ok().and_then(|mut guard| guard.take());
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }
    // 其余平台统一是 mpsc::Sender<()>
    macro_rules! stop_mpsc {
        ($t:ty) => {
            if let Some(state) = app.try_state::<$t>() {
                let tx = state.0.lock().ok().and_then(|mut guard| guard.take());
                if let Some(tx) = tx {
                    let _ = tx.try_send(());
                }
            }
        };
    }
    stop_mpsc!(DouyinDanmakuState);
    stop_mpsc!(BilibiliDanmakuState);
    stop_mpsc!(HuyaDanmakuState);
    stop_mpsc!(TwitchDanmakuState);

    // 本地代理服务（actix）：释放监听端口
    if let Some(state) = app.try_state::<proxy::ProxyServerHandle>() {
        let handle = state.0.lock().ok().and_then(|mut guard| guard.take());
        if let Some(handle) = handle {
            handle.stop(false);
        }
    }

    // 局域网同步服务：显式注销 mDNS，避免退出瞬间还在对外广播
    // 「本机可同步」——实际上服务已经没了，扫到的是个连不上的空壳。
    if let Some(state) = app.try_state::<lan_sync::LanSyncServerState>() {
        lan_sync::stop_now(&state);
    }
}

/// 已经决定真正退出：此时关闭窗口不再走「最小化到托盘」，必须真关。
/// pub(crate)：version_check 在安装器启动成功后也要走同一条退出路径，
/// 否则那里 app.exit(0) 时 QUITTING仍是 false，窗口事件会误走 hide 分支。
pub(crate) static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 把主窗口唤到前台。托盘左键、托盘菜单「显示」、以及「再次双击快捷方式」
/// 三处都要用同一套动作，缺任何一步都会出现「点了没反应」的情况：
/// - show：窗口可能被关到托盘隐藏了，必须先显示
/// - unminimize：窗口可能处于最小化状态，show 之后仍是最小化态，需要还原
/// - set_focus：显示出来不一定拿到焦点（尤其从托盘唤起时）
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // 通知前端：窗口已回到前台，可以恢复播放（与 main-window-hidden 成对）。
        // 注意必须放在 show 之后：前端收到就play，此时窗口已可见，autoplay 才不会被拦。
        let _ = app.emit("main-window-shown", ());
    }
}

/// 真正的退出：关掉所有窗口（含B站登录等子窗口，否则它们会拖住退出流程、
/// 留下「关了主窗口却还剩一个画面在跑」的残留进程），再退出应用。
/// pub(crate)：version_check 的「安装器已启动 → 退出」也复用它，保证退出行为一致。
pub(crate) fn really_quit(app: &tauri::AppHandle) {
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    shutdown_background_tasks(app);
    for (_label, window) in app.webview_windows() {
        let _ = window.close();
    }
    app.exit(0);
}

// Main function corrected
fn main() {
    logging::init();
    panic::set_hook(Box::new(|info| {
        eprintln!("[panic] {}", info);
    }));
    // 关键修复：禁用 WebView2/Chromium 的后台节流（计时器节流、遮挡判定、渲染降级）。
    // 否则应用挂后台/最小化时 hls.js/flv.js 的拉流与保活计时器被冻结 → 直播断流卡住，
    // 必须切回前台手动刷新。此环境变量在 WebView2 控制器创建前设置即可生效。
    #[cfg(target_os = "windows")]
    {
        env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion",
        );
    }
    // Create a new HTTP client instance to be managed by Tauri
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
        .http1_only()
        .connect_timeout(Duration::from_secs(15))
        .no_proxy()
        .timeout(Duration::from_secs(45))
        .build()
        .expect("Failed to create reqwest client");
    let follow_http_client = FollowHttpClient::new().expect("Failed to create follow http client");

    tauri::Builder::default()
            .plugin(tauri_plugin_os::init())
            .plugin(tauri_plugin_opener::init())
            // 单实例互斥：必须注册在靠前的位置。
            // 第二次启动时本进程不会走到 run()，而是把参数交给已有实例后立刻退出，
            // 所以不存在「开出第二个窗口 / 起第二套弹幕与代理」的问题。
            // 这里唤起已有窗口，才能做到「双击快捷方式 = 把托盘里的窗口叫回来」。
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                show_main_window(app);
            }))
            .plugin(tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                )
                .build())
            .setup(|app| {
                // Apply macOS vibrancy to the main window when running on macOS
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    if let Some(window) = app.get_webview_window("main") {
                        match apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None) {
                            Ok(_) => println!("vibrancy applied successfully"),
                            Err(e) => eprintln!("vibrancy error: {:?}", e),
                        }
                    }
                }

                // ===== 系统托盘 =====
                // 关闭主窗口时最小化到这里，而不是直接退出进程。
                let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "退出 DTV_X").build(app)?;
                let menu = MenuBuilder::new(app)
                    .items(&[&show_item, &quit_item])
                    .build()?;

                // 托盘图标：用 include_image! 把 PNG 字节编进二进制，得到 Image<'static>。
                // 注意不能用 app.default_window_icon() —— 它返回的是借用，
                // 而 Image::new(rgba: &'a [u8], ..) 也只接受借用，凑不出 'static。
                let tray = TrayIconBuilder::with_id("main")
                    .icon(tauri::include_image!("icons/32x32.png"));

                let _ = tray
                    .tooltip("DTV_X")
                    .menu(&menu)
                    // 左键单击 = 直接唤出窗口；右键才弹菜单
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => show_main_window(app),
                        "quit" => really_quit(app),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app);

                Ok(())
            })
            .on_window_event(|window, event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // 已决定真正退出 → 放行，让窗口真的关掉
                    if QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    if window.label() == "main" {
                        // 关闭主窗口 = 最小化到托盘，进程继续在后台跑。
                        // 顺手把 B站登录等子窗口一并关掉：它们如果还开着，既会留在屏幕上
                        // （就是「关了窗口却还剩一个画面在刷」），又会拖住进程没法真正退出。
                        for (label, child) in window.app_handle().webview_windows() {
                            if label != "main" {
                                let _ = child.close();
                            }
                        }
                        // 通知前端：窗口已隐藏，请暂停播放并停掉弹幕/代理。
                        // 为什么必须用 Rust 事件而不是前端 document.visibilityState：
                        // Tauri 的 hide() 只是隐藏窗口，WebView2 页面仍是 active，
                        // 不保证触发 visibilitychange —— 那样关窗后 <video> 会继续解码、
                        // 弹幕 WebSocket 继续收发、本地代理继续转发，白白吃流量和 CPU。
                        let _ = window.app_handle().emit("main-window-hidden", ());
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            })
            .manage(client) // Manage the reqwest client
            .manage(follow_http_client) // 专用关注刷新客户端，避免占用默认连接池
            .manage(DouyuDanmakuHandles::default()) // Manage new DouyuDanmakuHandles
            .manage(DouyinDanmakuState::default()) // Manage DouyinDanmakuState
            .manage(HuyaDanmakuState::default()) // Manage HuyaDanmakuState
            .manage(platforms::common::TwitchDanmakuState::default()) // Manage TwitchDanmakuState
            .manage(platforms::common::BilibiliDanmakuState::default()) // Manage BilibiliDanmakuState
            .manage(StreamUrlStore::default())
            .manage(proxy::ProxyServerHandle::default())
            .manage(platforms::bilibili::state::BilibiliState::default())
            .manage(lan_sync::LanSyncServerState::default())
            .manage(cache_cleaner::ExitCleanupFlag(std::sync::atomic::AtomicBool::new(true)))
            .invoke_handler(tauri::generate_handler![
                get_stream_url_cmd,
                get_stream_url_with_quality_cmd,
                set_stream_url_cmd,
                search_anchor,
                config_transfer::save_config_export,
                config_transfer::pick_config_import,
                sync_transfer::export_lan_sync_json_to_desktop,
                sync_transfer::pick_lan_sync_json_import,
                sync_transfer::import_latest_lan_sync_json_from_desktop,
                lan_sync::lan_sync_start_server,
                lan_sync::lan_sync_stop_server,
                lan_sync::lan_sync_status,
                lan_sync::lan_sync_token,
                lan_sync::lan_sync_discover,
                lan_sync::lan_sync_fetch_manifest,
                lan_sync::lan_sync_fetch_payload,
                start_danmaku_listener,      // Douyu danmaku start
                stop_danmaku_listener,       // Douyu danmaku stop
                start_douyin_danmu_listener, // Added Douyin danmaku listener command
                stop_douyin_danmu_listener,  // Added Douyin danmaku stop command
                start_huya_danmaku_listener, // Added Huya danmaku listener command
                stop_huya_danmaku_listener,  // Added Huya danmaku stop command
                platforms::bilibili::danmaku::start_bilibili_danmaku_listener,
                platforms::bilibili::danmaku::stop_bilibili_danmaku_listener,
                proxy::start_proxy,
                proxy::stop_proxy,
                proxy::start_static_proxy_server,
                fetch_categories,
                fetch_live_list,
                fetch_live_list_for_cate3,
                fetch_douyu_room_info,
                fetch_three_cate,
                generate_douyin_ms_token,
                fetch_douyin_partition_rooms,
                get_douyin_live_stream_url,
                get_douyin_live_stream_url_with_quality,
                fetch_douyin_room_info,
                fetch_douyin_streamer_info,
                fetch_huya_live_list,
                platforms::huya::danmaku::fetch_huya_join_params,
                platforms::huya::stream_url::get_huya_unified_cmd,
                platforms::bilibili::state::generate_bilibili_w_webid,
                platforms::bilibili::live_list::fetch_bilibili_live_list,
                platforms::bilibili::stream_url::get_bilibili_live_stream_url_with_quality,
                platforms::bilibili::streamer_info::fetch_bilibili_streamer_info,
                platforms::bilibili::cookie::get_bilibili_cookie,
                platforms::bilibili::cookie::bootstrap_bilibili_cookie,
                platforms::bilibili::cookie::open_bilibili_login_window,
                platforms::bilibili::cookie::bilibili_login_window_exists,
                platforms::bilibili::cookie::close_bilibili_login_window,
                cache_cleaner::set_exit_cleanup_enabled,
                platforms::bilibili::search::search_bilibili_rooms,
                platforms::huya::search::search_huya_anchors,
                open_in_default_browser,
                version_check::check_version_cmd,
                platforms::twitch::api::fetch_twitch_categories,
                platforms::twitch::api::fetch_twitch_live_list,
                platforms::twitch::api::get_twitch_stream_cmd,
                platforms::twitch::api::get_twitch_streamer_status,
                platforms::twitch::danmaku::start_twitch_danmaku_listener,
                platforms::twitch::danmaku::stop_twitch_danmaku_listener,
                version_check::download_and_install_cmd,
            ])
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app_handle, event| {
                match event {
                    // 进程即将退出：先让后台任务收手，尽快断开 WebSocket / 释放端口，
                    // 免得退出瞬间还挂着连接把 WebView2 的关闭流程拖住
                    tauri::RunEvent::ExitRequested { .. } => {
                        shutdown_background_tasks(app_handle);
                    }
                    // 应用退出时按设置清理 WebView2 缓存（登录态/设置/关注列表不受影响）
                    tauri::RunEvent::Exit => {
                        let flag = app_handle.state::<cache_cleaner::ExitCleanupFlag>();
                        cache_cleaner::cleanup_on_exit(app_handle, flag.inner());
                    }
                    _ => {}
                }
            });
}
