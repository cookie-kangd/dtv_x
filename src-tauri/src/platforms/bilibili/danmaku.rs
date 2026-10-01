use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::mpsc as tokio_mpsc;

use crate::platforms::bilibili::models::BiliMessage;
use crate::platforms::bilibili::websocket::BiliLiveClient;

#[tauri::command]
pub async fn start_bilibili_danmaku_listener(
    payload: crate::platforms::common::GetStreamUrlPayload,
    cookie: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::platforms::common::BilibiliDanmakuState>,
) -> Result<(), String> {
    let room_id = payload.args.room_id_str.clone();

    // stop previous listener if exists
    let previous_tx = {
        let mut lock = state.inner().0.lock().unwrap();
        lock.take()
    };
    if let Some(tx) = previous_tx {
        if tx.send(()).await.is_err() {
            eprintln!("[Bilibili Danmaku] 旧任务关闭失败，可能已退出。");
        }
    }

    let (tx_shutdown, mut rx_shutdown) = tokio_mpsc::channel::<()>(1);
    {
        let mut lock = state.inner().0.lock().unwrap();
        *lock = Some(tx_shutdown);
    }

    let app_handle_clone = app_handle.clone();
    let room_id_clone = room_id.clone();
    let cookie_clone = cookie.clone();

    // Use atomic flag to signal std::thread to stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_thread = stop_flag.clone();

    // Spawn std thread to run sync BiliLiveClient loop
    std::thread::spawn(move || {
        // B站初始化/连接路径已改为返回 Result（不再 panic），这里按失败次数做指数退避重试。
        // 连续失败超过阈值后降为低频重试（而非原来的无限快速重试），避免房间号非法 /
        // 持续被风控时线程长期空转、日志刷屏；同时保留低频重试，网络恢复后能自动连回。
        const FAST_RETRY_LIMIT: u32 = 5;
        const SLOW_RETRY_MS: u64 = 60_000;
        let mut backoff_ms: u64 = 1000;
        let mut failures: u32 = 0;
        loop {
            if stop_flag_for_thread.load(Ordering::Relaxed) {
                break;
            }
            let app_for_run = app_handle_clone.clone();
            let room_for_run = room_id_clone.clone();
            let cookie_for_run = cookie_clone.clone();
            let stop_for_run = stop_flag_for_thread.clone();
            // 保留一层 catch_unwind 作为最后兜底，正常失败路径已不再依赖它。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || -> Result<(), String> {
                let mut client = match cookie_for_run.as_ref() {
                    Some(c) => BiliLiveClient::new_with_cookie(c.as_str(), room_for_run.as_str())?,
                    None => BiliLiveClient::new_without_cookie(room_for_run.as_str())?,
                };
                client.send_auth();

                loop {
                    if stop_for_run.load(Ordering::Relaxed) {
                        break;
                    }
                    // 先把积压消息全部吐出（一个 WS 帧可能解析出几十条），
                    // 再休眠等待新数据，避免高热度房间下 pending 无界积压
                    while let Some(msg) = client.read_once() {
                        match msg {
                            BiliMessage::Danmu { user, text } => {
                                let _ = app_for_run.emit(
                                    "danmaku-message",
                                    crate::platforms::common::DanmakuFrontendPayload {
                                        room_id: room_for_run.clone(),
                                        user,
                                        content: text,
                                        user_level: 0,
                                        fans_club_level: 0,
                                        color: None,
                                    },
                                );
                            }
                            BiliMessage::Gift { user, gift } => {
                                let _ = app_for_run.emit(
                                    "danmaku-message",
                                    crate::platforms::common::DanmakuFrontendPayload {
                                        room_id: room_for_run.clone(),
                                        user,
                                        content: format!("[礼物] {}", gift),
                                        user_level: 0,
                                        fans_club_level: 0,
                                        color: None,
                                    },
                                );
                            }
                            BiliMessage::Unsupported { .. } => {
                                // ignore
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Ok(())
            }));
            let err: Option<String> = match result {
                Ok(Ok(())) => None, // 正常退出（收到停止信号）
                Ok(Err(e)) => Some(e),
                Err(_) => Some("弹幕线程内部 panic".to_string()),
            };
            match err {
                None => break,
                Some(e) => {
                    failures += 1;
                    let delay = if failures <= FAST_RETRY_LIMIT {
                        let d = backoff_ms;
                        backoff_ms = (backoff_ms * 2).min(30_000);
                        d
                    } else {
                        SLOW_RETRY_MS
                    };
                    // 日志降频：前几次每次都打，之后每 10 次打一次，避免刷屏
                    if failures <= FAST_RETRY_LIMIT || failures % 10 == 0 {
                        eprintln!(
                            "[Bili Danmaku {}] 连接失败（第 {} 次），{}ms 后重试：{}",
                            room_id_clone, failures, delay, e
                        );
                    }
                    // 可中断等待：分段 sleep，保证关闭播放器 / 切换房间时线程能立即退出
                    //（原实现一次性 sleep 最长 30s，期间停止信号完全无法被处理）
                    let mut remaining = delay;
                    let mut interrupted = false;
                    while remaining > 0 {
                        if stop_flag_for_thread.load(Ordering::Relaxed) {
                            interrupted = true;
                            break;
                        }
                        let step = remaining.min(500);
                        std::thread::sleep(std::time::Duration::from_millis(step));
                        remaining -= step;
                    }
                    if interrupted {
                        break;
                    }
                }
            }
        }
    });

    // Spawn a tokio task to listen for shutdown and set stop flag
    let stop_flag_for_task = stop_flag.clone();
    tokio::spawn(async move {
        let _ = rx_shutdown.recv().await; // wait for shutdown signal
        stop_flag_for_task.store(true, Ordering::Relaxed);
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_bilibili_danmaku_listener(
    state: tauri::State<'_, crate::platforms::common::BilibiliDanmakuState>,
) -> Result<(), String> {
    let previous_tx = {
        let mut lock = state.inner().0.lock().unwrap();
        lock.take()
    };
    if let Some(tx) = previous_tx {
        match tx.send(()).await {
            Ok(()) => Ok(()),
            Err(_) => Err("停止Bilibili弹幕监听失败：接收方已关闭".to_string()),
        }
    } else {
        Ok(())
    }
}
