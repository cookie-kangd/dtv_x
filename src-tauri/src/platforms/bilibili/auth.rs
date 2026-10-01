// src/auth.rs
use md5::{Digest, Md5};
use reqwest::header::{HeaderMap, HeaderValue};
#[allow(unused_imports)]
use reqwest::StatusCode;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

// WBI signing constants and functions (extracted)
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

#[derive(Deserialize)]
struct WbiImg {
    img_url: String,
    sub_url: String,
}

#[derive(Deserialize)]
struct Data {
    wbi_img: WbiImg,
}

#[derive(Deserialize)]
struct ResWbi {
    data: Data,
}

fn get_mixin_key(orig: &[u8]) -> String {
    MIXIN_KEY_ENC_TAB
        .iter()
        .take(32)
        .map(|&i| orig[i] as char)
        .collect::<String>()
}

fn get_url_encoded(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c.is_ascii_alphanumeric() || "-_.~".contains(c) {
            true => Some(c.to_string()),
            false => {
                if "!'()*".contains(c) {
                    return None;
                }
                let encoded = c
                    .encode_utf8(&mut [0; 4])
                    .bytes()
                    .fold("".to_string(), |acc, b| acc + &format!("%{:02X}", b));
                Some(encoded)
            }
        })
        .collect::<String>()
}

fn encode_wbi(params: Vec<(&str, String)>, (img_key, sub_key): (String, String)) -> String {
    // 系统时间早于 UNIX EPOCH 属于极端异常（时钟被改写），用 0 兜底即可，
    // 不能 panic：这里位于弹幕线程的取流路径上，panic 会导致线程反复重启。
    let cur_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_secs())
        .unwrap_or(0);
    _encode_wbi(params, (img_key, sub_key), cur_time)
}

fn _encode_wbi(
    mut params: Vec<(&str, String)>,
    (img_key, sub_key): (String, String),
    timestamp: u64,
) -> String {
    let mixin_key = get_mixin_key((img_key + &sub_key).as_bytes());
    params.push(("wts", timestamp.to_string()));
    params.sort_by(|a, b| a.0.cmp(b.0));
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", get_url_encoded(k), get_url_encoded(v)))
        .collect::<Vec<_>>()
        .join("&");
    let mut hasher = Md5::new();
    hasher.update((query.clone() + &mixin_key).as_bytes());
    let digest = hasher.finalize();
    let web_sign = format!("{:x}", digest);
    query + &format!("&w_rid={}", web_sign)
}

fn get_wbi_keys(headers: HeaderMap) -> Result<(String, String), String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .no_proxy()
        .build()
        .map_err(|e| format!("创建 WBI 请求客户端失败：{e}"))?;

    let mut request_headers = headers;
    request_headers.insert("user-agent", HeaderValue::from_static(USER_AGENT));

    let response = client
        .get(UID_INIT_URL)
        .headers(request_headers)
        .send()
        .map_err(|e| format!("请求 WBI 密钥失败：{e}"))?;

    let res_wbi: ResWbi = response
        .json()
        .map_err(|e| format!("解析 WBI 密钥响应失败：{e}"))?;
    let img = take_filename(res_wbi.data.wbi_img.img_url)
        .ok_or_else(|| "WBI img_url 格式异常".to_string())?;
    let sub = take_filename(res_wbi.data.wbi_img.sub_url)
        .ok_or_else(|| "WBI sub_url 格式异常".to_string())?;
    Ok((img, sub))
}

fn take_filename(url: String) -> Option<String> {
    url.rsplit_once('/')
        .and_then(|(_, s)| s.rsplit_once('.'))
        .map(|(s, _)| s.to_string())
}

pub const UID_INIT_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
pub const DANMAKU_SERVER_CONF_URL: &str =
    "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
pub const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0";

/// Get UID using cookie (optional). If request fails or no cookie, returns (status, body).
pub fn init_uid(headers: HeaderMap) -> (reqwest::StatusCode, String) {
    let client = match reqwest::blocking::Client::builder()
        .https_only(true)
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                format!("{{\"error\":\"{}\"}}", e),
            )
        }
    };

    let mut request_headers = headers;
    request_headers.insert("user-agent", HeaderValue::from_static(USER_AGENT));

    let response = client.get(UID_INIT_URL).headers(request_headers).send();
    let stat: reqwest::StatusCode;
    let body: String;
    match response {
        Ok(resp) => {
            let s: reqwest::StatusCode = resp.status();
            stat = s;
            match resp.text() {
                Ok(b) => body = b,
                Err(e) => body = format!("{{\"error\":\"{}\"}}", e),
            }
        }
        Err(err) => {
            stat = reqwest::StatusCode::INTERNAL_SERVER_ERROR;
            body = format!("{{\"error\":\"{}\"}}", err);
        }
    }
    (stat, body)
}

/// Query danmaku server host list and token via signed URL, with given headers.
/// 返回 Err 表示无法拿到弹幕服务器配置（网络异常 / 风控 / WBI 签名失败）。
pub fn init_host_server(headers: HeaderMap, room_id: u64) -> Result<(reqwest::StatusCode, String), String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .no_proxy()
        .build()
        .map_err(|e| format!("创建弹幕服务器请求客户端失败：{e}"))?;

    let mut request_headers = headers.clone();
    request_headers.insert("user-agent", HeaderValue::from_static(USER_AGENT));

    // 原实现在此 panic：网络抖动时会让整条弹幕线程崩溃并被反复重启。改为向上传播错误。
    let wbi_keys = match get_wbi_keys(request_headers.clone()) {
        Ok(keys) => keys,
        Err(e) => {
            log::error!("Failed to get WBI keys: {}", e);
            return Err(format!("获取 WBI 密钥失败：{e}"));
        }
    };

    let params = vec![
        ("id", room_id.to_string()),
        ("type", "0".to_string()),
        ("web_location", "444.8".to_string()),
    ];

    let signed_query = encode_wbi(params, wbi_keys);
    let url = format!("{}?{}", DANMAKU_SERVER_CONF_URL, signed_query);

    let response = client.get(url).headers(request_headers).send();
    let stat: reqwest::StatusCode;
    let body: String;
    match response {
        Ok(resp) => {
            let s: reqwest::StatusCode = resp.status();
            stat = s;
            body = resp.text().unwrap_or_default();
        }
        Err(_) => {
            stat = reqwest::StatusCode::INTERNAL_SERVER_ERROR;
            body = String::new();
        }
    }
    Ok((stat, body))
}

use super::models::AuthMessage;
use serde_json::Value;
use std::collections::HashMap;

/// Initialize server info and auth message using cookie.
///
/// 所有失败路径都返回 Err 而不是 panic：调用方位于弹幕后台线程，
/// panic 会被 catch_unwind 捕获并无限退避重试，造成长期空转与日志刷屏。
pub fn init_server_with_cookie(cookies: &str, room_id: &str) -> Result<(Value, AuthMessage), String> {
    let mut auth_map = HashMap::new();
    let mut headers = reqwest::header::HeaderMap::new();
    let cookie_value =
        HeaderValue::from_str(cookies).map_err(|e| format!("Cookie 含非法字符：{e}"))?;
    headers.insert(reqwest::header::COOKIE, cookie_value);
    headers.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_static(USER_AGENT),
    );

    // Try get uid via cookie (optional)
    let (_, body1) = init_uid(headers.clone());
    let body1_v: Value = serde_json::from_str(body1.as_str()).unwrap_or(Value::Null);
    if let Some(mid) = body1_v["data"]["mid"].as_i64() {
        auth_map.insert("uid".to_string(), mid.to_string());
    } else {
        auth_map.insert("uid".to_string(), "0".to_string());
    }

    auth_map.insert("room_id".to_string(), room_id.to_string());

    let room_id_num = room_id
        .parse::<u64>()
        .map_err(|_| format!("B站房间号非法（需要纯数字）：{room_id}"))?;
    let (_, body4) = init_host_server(headers.clone(), room_id_num)?;
    let body4_res: Value =
        serde_json::from_str(body4.as_str()).map_err(|e| format!("解析弹幕服务器响应失败：{e}"))?;
    let server_info = &body4_res["data"];
    let token = body4_res["data"]["token"]
        .as_str()
        .ok_or_else(|| format!("弹幕服务器未返回 token（可能被风控）：{body4_res}"))?;
    auth_map.insert("token".to_string(), token.to_string());

    let auth_msg = AuthMessage::from(&auth_map);
    Ok((server_info.clone(), auth_msg))
}

/// Initialize server info and auth message without cookie (uid=0)
pub fn init_server_no_cookie(room_id: &str) -> Result<(Value, AuthMessage), String> {
    let mut auth_map = HashMap::new();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_static(USER_AGENT),
    );

    auth_map.insert("uid".to_string(), "0".to_string());
    auth_map.insert("room_id".to_string(), room_id.to_string());

    let room_id_num = room_id
        .parse::<u64>()
        .map_err(|_| format!("B站房间号非法（需要纯数字）：{room_id}"))?;
    let (_, body4) = init_host_server(headers.clone(), room_id_num)?;
    let body4_res: Value =
        serde_json::from_str(body4.as_str()).map_err(|e| format!("解析弹幕服务器响应失败：{e}"))?;
    let server_info = &body4_res["data"];
    let token = body4_res["data"]["token"]
        .as_str()
        .ok_or_else(|| format!("弹幕服务器未返回 token（可能被风控）：{body4_res}"))?;
    auth_map.insert("token".to_string(), token.to_string());

    let auth_msg = AuthMessage::from(&auth_map);
    Ok((server_info.clone(), auth_msg))
}
