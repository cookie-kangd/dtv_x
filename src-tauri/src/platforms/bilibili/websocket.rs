// src/websocket.rs
use native_tls::TlsStream;
use serde_json::Value;
use std::collections::VecDeque;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tungstenite::{client, Message, WebSocket};
use url::Url;

use super::auth::{init_server_no_cookie, init_server_with_cookie};
use super::models::{BiliMessage, DanmuServer, MsgHead};

static DEBUG_FLAG: OnceLock<bool> = OnceLock::new();

pub fn is_debug_enabled() -> bool {
    *DEBUG_FLAG.get_or_init(|| {
        std::env::var("DMF_DEBUG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

macro_rules! ws_debug {
    ($($arg:tt)*) => {
        if crate::platforms::bilibili::websocket::is_debug_enabled() {
            println!($($arg)*);
        }
    }
}

pub struct BiliLiveClient {
    ws: WebSocket<TlsStream<TcpStream>>,
    auth_msg: String,
    // Keep server host list for reconnection
    host_list: Value,
    // Heartbeat scheduling
    last_heartbeat: Instant,
    heartbeat_interval: Duration,
    // Pending messages parsed from current/previous frames
    pending: VecDeque<BiliMessage>,
}

impl BiliLiveClient {
    // 构造失败一律返回 Err（网络异常 / 风控 / 房间号非法），不再 panic。
    pub fn new_with_cookie(cookies: &str, room_id: &str) -> Result<Self, String> {
        let (v, auth) = init_server_with_cookie(cookies, room_id)?;
        ws_debug!("[websocket] server_info host_list: {:?}", v["host_list"]);
        let ws = connect(v["host_list"].clone())?;
        ws_debug!("[websocket] connected via cookie for room {}", room_id);
        let auth_msg =
            serde_json::to_string(&auth).map_err(|e| format!("序列化鉴权信息失败：{e}"))?;
        Ok(BiliLiveClient {
            ws,
            auth_msg,
            host_list: v["host_list"].clone(),
            last_heartbeat: Instant::now(),
            heartbeat_interval: Duration::from_secs(30),
            pending: VecDeque::new(),
        })
    }

    pub fn new_without_cookie(room_id: &str) -> Result<Self, String> {
        let (v, auth) = init_server_no_cookie(room_id)?;
        ws_debug!("[websocket] server_info host_list: {:?}", v["host_list"]);
        let ws = connect(v["host_list"].clone())?;
        ws_debug!("[websocket] connected without cookie for room {}", room_id);
        let auth_msg =
            serde_json::to_string(&auth).map_err(|e| format!("序列化鉴权信息失败：{e}"))?;
        Ok(BiliLiveClient {
            ws,
            auth_msg,
            host_list: v["host_list"].clone(),
            last_heartbeat: Instant::now(),
            heartbeat_interval: Duration::from_secs(30),
            pending: VecDeque::new(),
        })
    }

    pub fn send_auth(&mut self) {
        let pkt = make_packet(self.auth_msg.as_str(), Operation::AUTH);
        ws_debug!("[websocket] sending auth packet, len={}", pkt.len());
        let _ = self.ws.send(Message::Binary(pkt));
    }

    pub fn send_heart_beat(&mut self) {
        let pkt = make_packet("{}", Operation::HEARTBEAT);
        ws_debug!("[websocket] sending heartbeat, len={}", pkt.len());
        let _ = self.ws.send(Message::Binary(pkt));
        // update heartbeat timestamp
        self.last_heartbeat = Instant::now();
    }

    // Periodically send heartbeat to keep the connection alive
    fn maybe_send_heartbeat(&mut self) {
        if self.last_heartbeat.elapsed() >= self.heartbeat_interval {
            ws_debug!("[websocket] periodic heartbeat due");
            self.send_heart_beat();
        }
    }

    // Try to reconnect using the cached host list, and re-authenticate.
    // connect() 已不再 panic（全部失败路径返回 Err），因此这里不需要 catch_unwind。
    fn reconnect(&mut self) {
        for attempt in 1..=2 {
            ws_debug!("[websocket] attempting reconnect (attempt {attempt}/2)...");
            match connect(self.host_list.clone()) {
                Ok(new_ws) => {
                    self.ws = new_ws;
                    ws_debug!(
                        "[websocket] reconnect successful on attempt {attempt}, resending auth"
                    );
                    self.send_auth();
                    return;
                }
                Err(e) => {
                    ws_debug!("[websocket] reconnect attempt {attempt} failed: {e}");
                }
            }
        }
        ws_debug!("[websocket] reconnect failed after 2 attempts; will retry on next read cycle");
    }

    // Parse one frame and collect all messages into pending queue
    pub fn parse_ws_message(&mut self, resv: Vec<u8>) -> Option<BiliMessage> {
        ws_debug!("[websocket] parse_ws_message: total_len={}", resv.len());
        // 防御性长度校验：帧头固定 16 字节。
        // 服务端可能下发截断帧；ver==3（brotli 压缩）分支解压后还会**递归**调用本函数，
        // 解压结果同样可能短于 16 字节。此前直接 `&resv[0..16]`，越界即 panic。
        if resv.len() < 16 {
            ws_debug!("[websocket] frame too short ({} < 16), ignoring", resv.len());
            return None;
        }
        let mut offset = 0;
        let header = &resv[0..16];
        let mut head_1 = get_msg_header(header);
        ws_debug!(
            "[websocket] header op={} ver={} pack_len={} seq={} hdr_size={}",
            head_1.operation,
            head_1.ver,
            head_1.pack_len,
            head_1.seq_id,
            head_1.raw_header_size
        );
        if head_1.operation == 5 || head_1.operation == 8 {
            loop {
                // 边界保护：帧头(16B)与整帧必须都完整落在缓冲区内，
                // 残包/截断帧直接丢弃，避免网络数据驱动的切片 panic
                if (head_1.pack_len as usize) < 16
                    || offset + 16 > resv.len()
                    || offset + (head_1.pack_len as usize) > resv.len()
                {
                    break;
                }
                let body: &[u8] = &resv[offset + 16..offset + (head_1.pack_len as usize)];
                ws_debug!(
                    "[websocket] chunk offset={} pack_len={} ver={} op={}",
                    offset,
                    head_1.pack_len,
                    head_1.ver,
                    head_1.operation
                );
                if let Some(msg) = self.parse_business_message(head_1, body) {
                    // push and continue to collect more messages
                    self.pending.push_back(msg);
                }
                offset += head_1.pack_len as usize;
                if offset >= resv.len() {
                    break;
                }
                if offset + 16 > resv.len() {
                    break;
                }
                let temp_head = &resv[offset..(offset + 16)];
                head_1 = get_msg_header(temp_head);
            }
        } else if head_1.operation == 3 {
            // 人气值帧 = 16 字节头 + 4 字节大端 i32 体。
            // 长度不足时必须跳过，否则 resv[16..19] 越界 panic。
            if resv.len() < 20 {
                ws_debug!("[websocket] op=3 frame too short ({} < 20), ignoring", resv.len());
                return None;
            }
            let body: [u8; 4] = [resv[16], resv[17], resv[18], resv[19]];
            let _popularity = i32::from_be_bytes(body);
            ws_debug!(
                "[websocket] popularity message op=3; popularity={}",
                _popularity
            );
        } else {
            ws_debug!("[websocket] unknown op={}, ignoring", head_1.operation);
        }
        None
    }

    fn parse_business_message(&mut self, h: MsgHead, b: &[u8]) -> Option<BiliMessage> {
        ws_debug!(
            "[websocket] parse_business_message op={} ver={} body_len={} ",
            h.operation,
            h.ver,
            b.len()
        );
        if h.operation == 5 {
            if h.ver == 3 {
                let res: Vec<u8> = match decompress(b) {
                    Ok(r) => r,
                    Err(e) => {
                        ws_debug!("[websocket] decompress error: {:?}", e);
                        return None;
                    }
                };
                ws_debug!("[websocket] decompressed len={}", res.len());
                return self.parse_ws_message(res);
            } else if h.ver == 0 {
                let s = match String::from_utf8(b.to_vec()) {
                    Ok(s) => s,
                    Err(e) => {
                        ws_debug!("[websocket] utf8 error: {:?}", e);
                        return None;
                    }
                };
                ws_debug!("[websocket] ver0 business json str len={}", s.len());
                let res_json: Value = match serde_json::from_str(s.as_str()) {
                    Ok(v) => v,
                    Err(e) => {
                        ws_debug!("[websocket] json parse error: {:?}", e);
                        return None;
                    }
                };
                ws_debug!(
                    "[websocket] business cmd={}",
                    res_json["cmd"].as_str().unwrap_or("<unknown>")
                );
                if let Some(m) = handle(res_json) {
                    // push into queue, but do not return immediately
                    self.pending.push_back(m);
                }
                None
            } else {
                ws_debug!("[websocket] unknown compression ver={}, skip", h.ver);
                None
            }
        } else if h.operation == 8 {
            ws_debug!("[websocket] op=8 (auth reply), sending heartbeat");
            self.send_heart_beat();
            None
        } else {
            ws_debug!("[websocket] unsupported business op={}, skip", h.operation);
            None
        }
    }

    pub fn read_once(&mut self) -> Option<BiliMessage> {
        // If we already have pending messages, deliver one immediately
        if let Some(m) = self.pending.pop_front() {
            return Some(m);
        }

        // ensure heartbeat keeps alive
        self.maybe_send_heartbeat();

        let readable = self.ws.can_read();
        ws_debug!("[websocket] can_read={} ", readable);
        if self.ws.can_read() {
            let msg = self.ws.read();
            match msg {
                Ok(m) => {
                    let res = m.into_data();
                    ws_debug!("[websocket] read frame bytes={} ", res.len());
                    if res.len() >= 16 {
                        // parse and fill pending queue
                        let _ = self.parse_ws_message(res);
                        // return one
                        return self.pending.pop_front();
                    } else {
                        ws_debug!("[websocket] frame too short (<16), ignore");
                    }
                }
                Err(e) => {
                    ws_debug!("[websocket] read error: {:?}", e);
                    // try to reconnect on read error
                    self.reconnect();
                }
            }
        }
        None
    }
}

pub fn gen_damu_list(list: &serde_json::Value) -> Vec<DanmuServer> {
    let mut res: Vec<DanmuServer> = Vec::new();
    if let Some(server_list) = list.as_array() {
        ws_debug!("[websocket] host_list size={}", server_list.len());
        if server_list.is_empty() {
            ws_debug!("[websocket] host_list empty, using default server");
            res.push(DanmuServer::default());
        } else {
            for s in server_list {
                let host = s["host"]
                    .as_str()
                    .unwrap_or("broadcastlv.chat.bilibili.com");
                let port = s["port"].as_i64().unwrap_or(2243) as i32;
                let wss_port = s["wss_port"].as_i64().unwrap_or(443) as i32;
                let ws_port = s["ws_port"].as_i64().unwrap_or(2244) as i32;
                ws_debug!(
                    "[websocket] server {}:{} (wss_port={}, ws_port={})",
                    host,
                    port,
                    wss_port,
                    ws_port
                );
                res.push(DanmuServer {
                    host: host.to_string(),
                    port,
                    wss_port,
                    ws_port,
                });
            }
        }
    } else {
        ws_debug!("[websocket] host_list not an array, using default server");
        res.push(DanmuServer::default());
    }
    res
}

fn find_server(vd: Vec<DanmuServer>) -> (String, String, String) {
    // gen_damu_list 保证至少返回一个默认服务器；这里再兜底一次，避免空列表 panic。
    let fallback = DanmuServer::default();
    let server = vd.first().unwrap_or(&fallback);
    let (host, wss_port) = (server.host.clone(), server.wss_port);
    ws_debug!(
        "[websocket] choose server host={} wss_port={}",
        host,
        wss_port
    );
    (
        host.clone(),
        format!("{}:{}", host.clone(), wss_port),
        format!("wss://{}:{}/sub", host, wss_port),
    )
}

pub fn connect(v: Value) -> Result<WebSocket<TlsStream<TcpStream>>, String> {
    let danmu_server = gen_damu_list(&v);
    let (host, url, ws_url) = find_server(danmu_server);
    ws_debug!("[websocket] connecting tcp {} and ws {}", url, ws_url);
    let connector: native_tls::TlsConnector =
        native_tls::TlsConnector::new().map_err(|e| format!("创建 TLS 连接器失败：{e}"))?;
    // connect_timeout：无超时的 TcpStream::connect 在网络异常时会阻塞 ~20s（OS SYN 超时），
    // 停止信号在此期间完全无法被处理；5s 超时保证关闭播放器时弹幕线程能及时退出
    let addr = url
        .to_socket_addrs()
        .and_then(|mut it| {
            it.next()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "no addr"))
        })
        .map_err(|e| format!("解析弹幕服务器地址 {url} 失败：{e}"))?;
    // ★ 必须设读超时：connect_timeout 只管握手。连接建立后再无任何读超时，
    //   服务端静默不推送时 self.ws.read() 会**永久阻塞**。
    //   而该函数跑在 danmaku.rs 的 std::thread::spawn 里，
    //   线程只在循环顶部检查 stop_flag —— 卡在 read() 上就永远退不出来，
    //   每次换房间都新 spawn 一个 → 线程与 socket 单调累积，进程退出也带不走。
    //   10s 超时后返回 WouldBlock/TimedOut，交给上层重连，线程得以检查 stop_flag 退出。
    //
    //   签名（已核对 std 官方文档）：fn set_read_timeout(&self, Option<Duration>)
    //       -> Result<(), Error>，set_write_timeout 同形。
    //   两者都是 &self + 返回 Result<()>，所以**不要**重新赋值给 stream，
    //   也不需要 mut —— 直接调用后用 ? 处理错误即可。
    let stream: TcpStream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("连接弹幕服务器 {url} 失败：{e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("设置弹幕 socket 读超时失败：{e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("设置弹幕 socket 写超时失败：{e}"))?;
    let stream: native_tls::TlsStream<TcpStream> = connector
        .connect(host.as_str(), stream)
        .map_err(|e| format!("TLS 握手失败（{host}）：{e}"))?;
    let parsed = Url::parse(ws_url.as_str()).map_err(|e| format!("弹幕地址非法：{e}"))?;
    let (socket, _resp) = client(parsed, stream).map_err(|e| format!("WebSocket 握手失败：{e}"))?;
    ws_debug!("[websocket] websocket handshake complete");
    Ok(socket)
}

pub enum Operation {
    AUTH,
    HEARTBEAT,
}

pub fn make_packet(body: &str, ops: Operation) -> Vec<u8> {
    // body 由内部构造（紧凑 JSON），解析失败时退化为 null 而不是 panic。
    let json: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let temp = json.to_string();
    let body_content: &[u8] = temp.as_bytes();
    // 包长必须与实际发送的 body 字节数一致：原实现用入参 body.len()，
    // 一旦入参含多余空白就会导致声明长度与实际不符。
    let pack_len: [u8; 4] = ((16 + temp.len()) as u32).to_be_bytes();
    let raw_header_size: [u8; 2] = (16 as u16).to_be_bytes();
    let ver: [u8; 2] = (1 as u16).to_be_bytes();
    let operation: [u8; 4] = match ops {
        Operation::AUTH => (7 as u32).to_be_bytes(),
        Operation::HEARTBEAT => (2 as u32).to_be_bytes(),
    };
    let seq_id: [u8; 4] = (1 as u32).to_be_bytes();
    let mut res = pack_len.to_vec();
    res.append(&mut raw_header_size.to_vec());
    res.append(&mut ver.to_vec());
    res.append(&mut operation.to_vec());
    res.append(&mut seq_id.to_vec());
    res.append(&mut body_content.to_vec());
    res
}

pub fn get_msg_header(v_s: &[u8]) -> MsgHead {
    let mut pack_len: [u8; 4] = [0; 4];
    let mut raw_header_size: [u8; 2] = [0; 2];
    let mut ver: [u8; 2] = [0; 2];
    let mut operation: [u8; 4] = [0; 4];
    let mut seq_id: [u8; 4] = [0; 4];
    for (i, v) in v_s.iter().enumerate() {
        if i < 4 {
            pack_len[i] = *v;
            continue;
        }
        if i < 6 {
            raw_header_size[i - 4] = *v;
            continue;
        }
        if i < 8 {
            ver[i - 6] = *v;
            continue;
        }
        if i < 12 {
            operation[i - 8] = *v;
            continue;
        }
        if i < 16 {
            seq_id[i - 12] = *v;
            continue;
        }
    }
    MsgHead {
        pack_len: u32::from_be_bytes(pack_len),
        raw_header_size: u16::from_be_bytes(raw_header_size),
        ver: u16::from_be_bytes(ver),
        operation: u32::from_be_bytes(operation),
        seq_id: u32::from_be_bytes(seq_id),
    }
}

pub fn decompress(body: &[u8]) -> std::io::Result<Vec<u8>> {
    use brotlic::DecompressorReader;
    use std::io::Read;
    let mut decompressed_reader: DecompressorReader<&[u8]> = DecompressorReader::new(body);
    let mut decoded_input = Vec::new();
    let _ = decompressed_reader.read_to_end(&mut decoded_input)?;
    Ok(decoded_input)
}

pub fn handle(json: Value) -> Option<BiliMessage> {
    let category = json["cmd"].as_str().unwrap_or("");
    match category {
        "DANMU_MSG" => Some(BiliMessage::Danmu {
            user: json["info"][2][1]
                .as_str()
                .unwrap_or("<unknown>")
                .to_string(),
            text: json["info"][1].as_str().unwrap_or("").to_string(),
        }),
        "SEND_GIFT" => Some(BiliMessage::Gift {
            user: json["info"][2][1]
                .as_str()
                .unwrap_or("<unknown>")
                .to_string(),
            gift: json["info"][1].as_str().unwrap_or("").to_string(),
        }),
        _ => Some(BiliMessage::Unsupported {
            cmd: category.to_string(),
        }),
    }
}
