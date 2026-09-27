// Twitch IRC 弹幕（匿名 justinfan 登录），参考 dtv_mx 的 TwitchDanmakuClientAndroid。
//
// 协议：wss 文本帧；连接后 CAP REQ + NICK justinfanXXXXX + JOIN #<login>，
// 服务端定期 PING 需回 PONG；弹幕为 PRIVMSG 行，tags 里带 display-name / color（hex）。
use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use tauri::Emitter;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};

const DANMU_WS: &str = "wss://irc-ws.chat.twitch.tv:443";

enum ConnectionOutcome {
    Stop,
    Disconnected,
}

/// 从一行 IRC 消息里解析 tags（@k=v;k2=v2 段）为键值对
fn parse_irc_tags(line: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if !line.starts_with('@') {
        return map;
    }
    let tags_end = match line.find(' ') {
        Some(i) => i,
        None => return map,
    };
    for pair in line[1..tags_end].split(';') {
        if let Some(eq) = pair.find('=') {
            map.insert(pair[..eq].to_string(), pair[eq + 1..].to_string());
        }
    }
    map
}

/// 解析 PRIVMSG 行 → (user, content, color)
fn parse_privmsg(line: &str) -> Option<(String, String, Option<String>)> {
    let idx = line.find("PRIVMSG ")?;
    // 正文：PRIVMSG 之后第一个 " :" 后面的内容
    let body = &line[idx..];
    let content = body
        .find(" :")
        .map(|i| body[i + 2..].trim().to_string())
        .filter(|s| !s.is_empty())?;
    let tags = parse_irc_tags(line);
    let user = tags
        .get("display-name")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| tags.get("nick").cloned())
        .unwrap_or_else(|| "unknown".to_string());
    let color = tags
        .get("color")
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with('#') && s.len() > 1);
    Some((user, content, color))
}

#[tauri::command]
pub async fn start_twitch_danmaku_listener(
    payload: crate::platforms::common::GetStreamUrlPayload,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::platforms::common::TwitchDanmakuState>,
) -> Result<(), String> {
    let channel = payload.args.room_id_str.trim().to_lowercase();
    if channel.is_empty() {
        return Err("Twitch 频道名为空".to_string());
    }
    info!("[Twitch Danmaku] start listener channel={}", channel);

    // 停止已有监听
    let previous_tx = {
        let mut lock = state.inner().0.lock().unwrap();
        lock.take()
    };
    if let Some(tx) = previous_tx {
        if tx.send(()).await.is_err() {
            eprintln!("[Twitch Danmaku] 旧任务关闭失败，可能已退出。");
        }
    }

    let (tx_shutdown, mut rx_shutdown) = tokio_mpsc::channel::<()>(1);
    {
        let mut lock = state.inner().0.lock().unwrap();
        *lock = Some(tx_shutdown);
    }

    let app_handle_clone = app_handle.clone();
    let channel_clone = channel.clone();

    tokio::spawn(async move {
        let mut backoff_secs = 1u64;

        loop {
            let attempt_started = std::time::Instant::now();
            let result: anyhow::Result<ConnectionOutcome> = async {
                let (ws_stream, _) = connect_async(DANMU_WS).await?;
                let (mut ws_write, mut ws_read) = ws_stream.split();

                // 匿名登录三件套
                ws_write
                    .send(WsMessage::Text("CAP REQ :twitch.tv/tags twitch.tv/commands".into()))
                    .await?;
                let nick = format!(
                    "justinfan{}",
                    10_000 + (rand::random::<u64>() % 90_000)
                );
                ws_write.send(WsMessage::Text(format!("NICK {}", nick))).await?;
                ws_write
                    .send(WsMessage::Text(format!("JOIN #{}", channel_clone)))
                    .await?;

                // 周期性应用层心跳保活（服务端 PING 由 recv 侧回 PONG；
                // 这里额外每 3 分钟主动 PONG 一次，避免部分网络环境下空闲断链）
                let keepalive_task = async {
                    loop {
                        sleep(Duration::from_secs(180)).await;
                        if ws_write.send(WsMessage::Text("PONG :tmi.twitch.tv".into())).await.is_err() {
                            return Err::<(), anyhow::Error>(anyhow::anyhow!("Twitch keepalive send failed"));
                        }
                    }
                };

                let recv_task = async {
                    while let Some(m) = ws_read.next().await {
                        let m = match m {
                            Ok(x) => x,
                            Err(e) => return Err(anyhow::anyhow!(e)),
                        };
                        let text = match m {
                            WsMessage::Text(t) => t,
                            WsMessage::Ping(p) => {
                                let _ = ws_write.send(WsMessage::Pong(p)).await;
                                continue;
                            }
                            WsMessage::Close(_) => {
                                return Err(anyhow::anyhow!("Twitch irc closed by server"));
                            }
                            other => {
                                log::debug!("[Twitch Danmaku] non-text ws message: {:?}", other);
                                continue;
                            }
                        };
                        for line in text.split("\r\n") {
                            let line = line.trim();
                            if line.is_empty() {
                                continue;
                            }
                            if line.starts_with("PING") {
                                let _ = ws_write.send(WsMessage::Text("PONG :tmi.twitch.tv".into())).await;
                                continue;
                            }
                            if !line.contains("PRIVMSG") {
                                continue;
                            }
                            if let Some((user, content, color)) = parse_privmsg(line) {
                                let _ = app_handle_clone.emit(
                                    "danmaku-message",
                                    crate::platforms::common::DanmakuFrontendPayload {
                                        room_id: channel_clone.clone(),
                                        user,
                                        content,
                                        user_level: 0,
                                        fans_club_level: 0,
                                        color,
                                    },
                                );
                            }
                        }
                    }
                    anyhow::Ok(())
                };

                tokio::select! {
                    _ = rx_shutdown.recv() => Ok(ConnectionOutcome::Stop),
                    it = keepalive_task => {
                        if let Err(e) = it { warn!("[Twitch Danmaku] {}", e); }
                        Ok(ConnectionOutcome::Disconnected)
                    }
                    it = recv_task => {
                        if let Err(e) = it { warn!("[Twitch Danmaku] recv error: {}", e); }
                        Ok(ConnectionOutcome::Disconnected)
                    }
                }
            }
            .await;

            match &result {
                Ok(ConnectionOutcome::Stop) => break,
                Ok(ConnectionOutcome::Disconnected) => {
                    warn!("[Twitch Danmaku] Disconnected, retrying in {}s.", backoff_secs);
                }
                Err(e) => {
                    warn!("[Twitch Danmaku] Connection error: {}. Retrying in {}s.", e, backoff_secs);
                }
            }

            if matches!(&result, Ok(ConnectionOutcome::Disconnected))
                && attempt_started.elapsed().as_secs() >= 60
            {
                backoff_secs = 1;
            }

            let sleep_fut = sleep(Duration::from_secs(backoff_secs));
            tokio::select! {
                _ = sleep_fut => {}
                _ = rx_shutdown.recv() => break,
            }
            backoff_secs = (backoff_secs * 2).min(30);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_twitch_danmaku_listener(
    _room_id: String,
    state: tauri::State<'_, crate::platforms::common::TwitchDanmakuState>,
) -> Result<(), String> {
    let tx = {
        let mut lock = state.inner().0.lock().unwrap();
        lock.take()
    };
    if let Some(tx) = tx {
        let _ = tx.send(()).await;
    }
    Ok(())
}
