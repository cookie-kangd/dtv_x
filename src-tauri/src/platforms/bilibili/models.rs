// src/models.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug)]
#[allow(dead_code)]
pub struct DanmuServer {
    pub host: String,
    pub port: i32,
    pub wss_port: i32,
    pub ws_port: i32,
}

impl Default for DanmuServer {
    fn default() -> Self {
        Self {
            host: String::from("broadcastlv.chat.bilibili.com"),
            port: 2243,
            wss_port: 443,
            ws_port: 2244,
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct MsgHead {
    pub pack_len: u32,
    pub raw_header_size: u16,
    pub ver: u16,
    pub operation: u32,
    pub seq_id: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthMessage {
    pub uid: u64,
    pub roomid: u64,
    pub protover: i32,
    pub platform: String,
    pub type_: i32,
    pub key: String,
}

impl AuthMessage {
    pub fn from(map: &HashMap<String, String>) -> AuthMessage {
        // uid 来自 Cookie 里的 mid，正常是数字，但风控/异常响应时可能返回非数字。
        // 原来的 parse().unwrap() 会 panic —— 虽被弹幕线程的 catch_unwind 兜住不至于崩应用，
        // 后果是「B站弹幕静默失效 + 每 60s 重试刷日志」，很难排查。
        // uid 缺失或非法时退回 0（项目里 init_server_no_cookie 本来就传 "0"），不阻断连接。
        let uid = map
            .get("uid")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        AuthMessage {
            uid,
            roomid: map.get("room_id").unwrap().parse::<u64>().unwrap(),
            protover: 3,
            platform: "web".to_string(),
            type_: 2,
            key: map.get("token").unwrap().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BiliMessage {
    Danmu { user: String, text: String },
    Gift { user: String, gift: String },
    Unsupported { cmd: String },
}
