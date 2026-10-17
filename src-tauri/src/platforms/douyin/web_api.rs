use crate::platforms::common::http_client::HttpClient;
use crate::platforms::douyin::a_bogus::generate_a_bogus;
use regex::Regex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, COOKIE, REFERER, SET_COOKIE, USER_AGENT,
};
use serde_json::Value;

// Align UA with the working Douyin Rust sample to keep a_bogus inputs consistent.
pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400";
const LIVE_BASE: &str = "https://live.douyin.com";

#[derive(Debug, Clone)]
pub struct DouyinRoomData {
    pub room: Value,
}

/// 抖音房间对象的直播状态：2 = 直播中，4 = 已结束/未开播。
///
/// 缺失或非法状态说明接口响应不完整，必须报错——历史上这里用
/// `unwrap_or_default()` 兜底成 0，接口抖动会直接把主播显示成「未开播」。
pub fn room_status(room: &Value) -> Result<i32, String> {
    room.get("status")
        .and_then(Value::as_i64)
        .filter(|status| *status >= 0)
        .and_then(|status| i32::try_from(status).ok())
        .ok_or_else(|| "抖音房间数据缺少有效直播状态".to_string())
}

#[derive(Debug, Clone)]
pub struct DouyinStream {
    pub key: String,
    pub name: String,
    pub level: i64,
    pub url: String,
    pub format: &'static str,
}

// 直接从返回的 stream_data 中补全 ORIGIN，不依赖 HTML 解析，贴近 douyin_rust 实现。
fn merge_origin_stream(room: &mut Value) {
    let Some(stream_url) = room.get_mut("stream_url") else { return };
    let live_core_sdk_data = stream_url.get("live_core_sdk_data");
    if live_core_sdk_data.is_none() {
        return;
    }

    let pull_datas = stream_url.get("pull_datas").and_then(|v| v.as_object());
    let json_str = if let Some(pd) = pull_datas {
        if let Some((_, entry)) = pd.iter().next() {
            entry
                .get("stream_data")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        } else {
            None
        }
    } else {
        live_core_sdk_data
            .and_then(|d| d.get("pull_data"))
            .and_then(|p| p.get("stream_data"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
    };
    let Some(json_str) = json_str else { return };

    let parsed: Value = serde_json::from_str(&json_str).unwrap_or(Value::Null);
    let origin_main = parsed
        .get("data")
        .and_then(|d| d.get("origin"))
        .and_then(|o| o.get("main"));
    let Some(origin_main) = origin_main else { return };

    let origin_codec = origin_main
        .get("sdk_params")
        .and_then(|s| s.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.get("VCodec").cloned())
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let origin_hls = origin_main
        .get("hls")
        .and_then(|v| v.as_str())
        .map(|s| format!("{}&codec={}", s, origin_codec));
    let origin_flv = origin_main
        .get("flv")
        .and_then(|v| v.as_str())
        .map(|s| format!("{}&codec={}", s, origin_codec));

    if let Some(hls_origin) = origin_hls {
        match stream_url.get_mut("hls_pull_url_map") {
            Some(map_val) if map_val.is_object() => {
                if let Some(map) = map_val.as_object_mut() {
                    let existing = map.clone();
                    map.clear();
                    map.insert("ORIGIN".to_string(), Value::String(hls_origin.clone()));
                    map.extend(existing);
                }
            }
            _ => {
                let mut new_map = serde_json::Map::new();
                new_map.insert("ORIGIN".to_string(), Value::String(hls_origin));
                stream_url.as_object_mut().map(|obj| {
                    obj.insert("hls_pull_url_map".to_string(), Value::Object(new_map))
                });
            }
        }
    }

    if let Some(flv_origin) = origin_flv {
        match stream_url.get_mut("flv_pull_url") {
            Some(map_val) if map_val.is_object() => {
                if let Some(map) = map_val.as_object_mut() {
                    let existing = map.clone();
                    map.clear();
                    map.insert("ORIGIN".to_string(), Value::String(flv_origin.clone()));
                    map.extend(existing);
                }
            }
            _ => {
                let mut new_map = serde_json::Map::new();
                new_map.insert("ORIGIN".to_string(), Value::String(flv_origin));
                stream_url.as_object_mut().map(|obj| {
                    obj.insert("flv_pull_url".to_string(), Value::Object(new_map))
                });
            }
        }
    }
}

fn request_headers(referer: &str, cookies: Option<&str>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
    headers.insert(
        REFERER,
        HeaderValue::from_str(referer).map_err(|e| e.to_string())?,
    );
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    // 没有账号 Cookie 时交给 HttpClient 的访客 Cookie Jar，
    // 不再复用写死的（且早已过期的）ttwid —— 过期凭据反而会让接口直接拒绝。
    if let Some(cookie) = cookies.filter(|cookie| !cookie.trim().is_empty()) {
        headers.insert(
            COOKIE,
            HeaderValue::from_str(cookie).map_err(|e| e.to_string())?,
        );
    }
    Ok(headers)
}

/// 合并页面回包里的访客会话字段，保留原有账号相关字段不被覆盖。
fn merge_cookies(original: Option<&str>, updates: &HeaderMap) -> String {
    let mut values = std::collections::BTreeMap::new();
    for entry in original.unwrap_or_default().split(';') {
        let entry = entry.trim();
        if let Some((key, _)) = entry.split_once('=') {
            values.insert(key.to_string(), entry.to_string());
        }
    }
    for value in updates.get_all(SET_COOKIE) {
        let Some(entry) = value.to_str().ok().and_then(|value| value.split(';').next()) else {
            continue;
        };
        let entry = entry.trim();
        if let Some((key, _)) = entry.split_once('=') {
            if matches!(key, "ttwid" | "__ac_nonce" | "msToken") {
                values.insert(key.to_string(), entry.to_string());
            }
        }
    }
    values.into_values().collect::<Vec<_>>().join("; ")
}

async fn refresh_web_cookie(http: &HttpClient, page: &str, cookies: Option<&str>) -> String {
    match request_headers(page, cookies) {
        Ok(headers) => match http.inner.head(page).headers(headers).send().await {
            // HEAD 即使返回 404 也可能发放访客会话。
            Ok(response) => merge_cookies(cookies, response.headers()),
            Err(_) => cookies.unwrap_or_default().to_string(),
        },
        Err(_) => cookies.unwrap_or_default().to_string(),
    }
}

#[derive(Debug)]
struct RoomApiError {
    message: String,
    /// 是否值得换一份访客会话重试（HTTP 444、非 JSON、缺房间数据都属于会话被拒）。
    refresh_session: bool,
}

async fn request_api_room(
    http: &HttpClient,
    api: &str,
    referer: &str,
    cookies: Option<&str>,
) -> Result<DouyinRoomData, RoomApiError> {
    let headers = request_headers(referer, cookies).map_err(|message| RoomApiError {
        message,
        refresh_session: false,
    })?;
    let response = http
        .inner
        .get(api)
        .headers(headers)
        .send()
        .await
        .map_err(|e| RoomApiError {
            message: format!("抖音接口请求失败：{e}"),
            refresh_session: false,
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(RoomApiError {
            message: format!("抖音接口返回 HTTP {status}"),
            refresh_session: status.as_u16() == 444,
        });
    }
    let json: Value = response.json().await.map_err(|e| RoomApiError {
        message: format!("抖音接口未返回有效 JSON：{e}"),
        refresh_session: true,
    })?;
    let mut room = json
        .pointer("/data/data/0")
        .filter(|room| room.is_object())
        .cloned()
        .ok_or_else(|| RoomApiError {
            message: "抖音接口未返回有效房间数据".into(),
            refresh_session: true,
        })?;
    // 房间数据必须带有效直播状态，否则无法区分「未开播」和「接口异常」。
    room_status(&room).map_err(|message| RoomApiError {
        message,
        refresh_session: true,
    })?;
    if let Some(user) = json.pointer("/data/user").filter(|user| user.is_object()) {
        let object = room.as_object_mut().unwrap();
        if let Some(name) = user.get("nickname").and_then(Value::as_str) {
            object.insert("anchor_name".into(), Value::String(name.to_string()));
        }
        if object.get("anchor").map_or(true, |anchor| !anchor.is_object()) {
            object.insert("anchor".into(), user.clone());
        }
    }
    merge_origin_stream(&mut room);
    Ok(DouyinRoomData { room })
}

fn signed_api_url(api: &str, query: &str) -> String {
    format!(
        "{api}?{query}&a_bogus={}",
        generate_a_bogus(query, DEFAULT_USER_AGENT)
    )
}

/// 取房间数据的接口流程：签名请求 → 换访客会话后用无签名请求 → 重新签名；
/// 失败时带回本次实际使用的 Cookie，供上层继续做网页回退。
async fn fetch_room_from_api(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
) -> Result<DouyinRoomData, (String, String)> {
    let referer = format!("{base}/{id}");
    let api = format!("{base}/webcast/room/web/enter/");
    let params = [
        ("aid", "6383"),
        ("app_name", "douyin_web"),
        ("live_id", "1"),
        ("device_platform", "web"),
        ("language", "zh-CN"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("browser_name", "Chrome"),
        ("browser_version", "125.0.0.0"),
        ("web_rid", id),
        ("msToken", ""),
    ];
    let query = serde_urlencoded::to_string(params)
        .map_err(|e| (e.to_string(), cookies.unwrap_or_default().to_string()))?;
    match request_api_room(http, &signed_api_url(&api, &query), &referer, cookies).await {
        Ok(room) => Ok(room),
        Err(error) if error.refresh_session => {
            let refreshed = refresh_web_cookie(http, &format!("{base}/"), cookies).await;
            let cookies = if refreshed.is_empty() {
                cookies
            } else {
                Some(refreshed.as_str())
            };
            match request_api_room(http, &format!("{api}?{query}"), &referer, cookies).await {
                Ok(room) => Ok(room),
                Err(error) if error.refresh_session => {
                    // 新会话重新生成签名；重签失败保留备用请求的原始错误。
                    request_api_room(http, &signed_api_url(&api, &query), &referer, cookies)
                        .await
                        .map_err(|_| (error.message, refreshed.clone()))
                }
                Err(error) => Err((error.message, refreshed)),
            }
        }
        Err(error) => Err((error.message, cookies.unwrap_or_default().to_string())),
    }
}

/// 从直播间网页里取出内嵌的 `self.__pace_f.push([n, "..."])` 片段，
/// 再流式解析其中的 `state.roomStore.roomInfo`。
///
/// 签名接口被拒（HTTP 444 / 风控）时这是唯一的兜底路径，
/// 用流式 JSON 解码避免房间里的大对象被字符串里的括号/转义截断。
fn parse_room_html(html: &str) -> Result<DouyinRoomData, String> {
    let chunks = Regex::new(
        r#"self\.__(?:next|pace)_f\.push\(\s*\[\s*\d+\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)"#,
    )
    .map_err(|e| e.to_string())?;
    let state_start = Regex::new(r#"\{\s*"state"\s*:"#).map_err(|e| e.to_string())?;
    for chunk in chunks.captures_iter(html) {
        let Ok(payload) = serde_json::from_str::<String>(&chunk[1]) else {
            continue;
        };
        let Some(start) = state_start.find(&payload).map(|matched| matched.start()) else {
            continue;
        };
        let Some(Ok(data)) = serde_json::Deserializer::from_str(&payload[start..])
            .into_iter::<Value>()
            .next()
        else {
            continue;
        };
        let Some(info) = data.pointer("/state/roomStore/roomInfo") else {
            continue;
        };
        let Some(mut room) = info.get("room").filter(|room| room.is_object()).cloned() else {
            continue;
        };
        if let Some(anchor) = info.get("anchor").filter(|anchor| anchor.is_object()) {
            room.as_object_mut()
                .unwrap()
                .insert("anchor".into(), anchor.clone());
        }
        merge_origin_stream(&mut room);
        if room_status(&room).is_ok() {
            return Ok(DouyinRoomData { room });
        }
    }
    Err("抖音网页未返回有效直播间数据，可能需要验证或页面结构已变化".into())
}

/// 优先走签名接口；被拒时换成访客会话再抓一次网页兜底。
/// 兜底失败时保留接口的原始错误，而不是把它变成「未开播」。
async fn fetch_room_by_web_rid(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
) -> Result<DouyinRoomData, String> {
    match fetch_room_from_api(http, id, cookies, base).await {
        Ok(room) => Ok(room),
        Err((api_error, active_cookie)) => {
            let page = format!("{base}/{id}");
            let cookies = if active_cookie.is_empty() {
                cookies
            } else {
                Some(active_cookie.as_str())
            };
            let merged = refresh_web_cookie(http, &page, cookies).await;
            let page_cookie = if merged.is_empty() {
                cookies
            } else {
                Some(merged.as_str())
            };
            let fallback = async {
                let html = http
                    .get_text_with_headers(&page, Some(request_headers(&page, page_cookie)?))
                    .await?;
                parse_room_html(&html)
            }
            .await;
            fallback.map_err(|_| api_error)
        }
    }
}

/// Normalize user input into a Douyin web_id. Supports raw IDs and full URLs such as
/// `https://live.douyin.com/123456` or `https://www.douyin.com/follow/live/123456`.
///
/// 同时带稳定 web_rid 与临时 room_id 的分享链接优先 web_rid。
pub fn normalize_douyin_live_id(input: &str) -> String {
    let input = input.trim();
    if input.is_empty() {
        return String::new();
    }
    if let Some(qpos) = input.find('?') {
        let params: Vec<(String, String)> =
            serde_urlencoded::from_str(input[qpos + 1..].split('#').next().unwrap_or(""))
                .unwrap_or_default();
        for key in ["web_rid", "webRid", "webId", "room_id", "roomId"] {
            if let Some((_, value)) = params
                .iter()
                .find(|(name, value)| name == key && !value.is_empty())
            {
                return value.clone();
            }
        }
    }
    if let Some(pos) = input.find("douyin.com/") {
        let path = input[pos + "douyin.com/".len()..]
            .split(['?', '#'])
            .next()
            .unwrap_or("");
        if let Some(segment) = path.rsplit('/').find(|segment| !segment.is_empty()) {
            return segment.to_string();
        }
    }
    input
        .split(['?', '&', '#'])
        .next()
        .unwrap_or(input)
        .to_string()
}

fn value_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn room_web_rid(room: &Value) -> Option<String> {
    room.pointer("/owner/web_rid")
        .and_then(value_id)
        .or_else(|| room.pointer("/anchor/web_rid").and_then(value_id))
        .or_else(|| room.get("web_rid").and_then(value_id))
}

pub async fn fetch_room_data(
    http: &HttpClient,
    raw_id: &str,
    cookies: Option<&str>,
) -> Result<DouyinRoomData, String> {
    let id = normalize_douyin_live_id(raw_id);
    fetch_room_by_id(
        http,
        &id,
        cookies,
        LIVE_BASE,
        "https://webcast.amemv.com/webcast/room/reflow/info/",
    )
    .await
}

/// 稳定的 webRid 走直播间接口；超长的临时 roomId 必须先经 reflow 换成稳定房间号，
/// 直接当 web_rid 传过去只会拿到空房间。
async fn fetch_room_by_id(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    live_base: &str,
    reflow_api: &str,
) -> Result<DouyinRoomData, String> {
    if id.is_empty() {
        return Err("抖音房间 ID 不能为空".into());
    }
    if id.len() <= 16 {
        return fetch_room_by_web_rid(http, id, cookies, live_base).await;
    }
    let params = [
        ("type_id", "0"),
        ("live_id", "1"),
        ("room_id", id),
        ("sec_user_id", ""),
        ("version_code", "99.99.99"),
        ("app_id", "6383"),
    ];
    let query = serde_urlencoded::to_string(params).map_err(|e| e.to_string())?;
    let json: Value = http
        .get_json_with_headers(
            &format!("{reflow_api}?{query}"),
            Some(request_headers(live_base, cookies)?),
        )
        .await?;
    let room = json
        .pointer("/data/room")
        .filter(|room| room.is_object())
        .cloned()
        .ok_or_else(|| "抖音 reflow 接口未返回有效房间数据".to_string())?;
    // 关播场次只带临时 roomId，需要跟随它的稳定房间号继续查。
    if room_status(&room)? == 4 {
        if let Some(web_rid) = room_web_rid(&room) {
            return fetch_room_by_web_rid(http, &web_rid, cookies, live_base).await;
        }
    }
    Ok(DouyinRoomData { room })
}

/// 把抖音的流键/清晰度名归一到统一的画质标签。
///
/// 抖音对同一画质可能给出多套命名（sdk_key 形如 `origin`/`hd`，
/// 拉流映射形如 `ORIGIN`/`FULL_HD1`/`HD1`），必须按语义而不是字典序选择。
fn quality_tag(key: &str, name: &str) -> &'static str {
    if name.contains("原画") || key.eq_ignore_ascii_case("origin") {
        return "OD";
    }
    if name.contains("蓝光") {
        return "BD";
    }
    if name.contains("超清") {
        return "UHD";
    }
    if name.contains("高清") {
        return "HD";
    }
    if name.contains("标清") {
        return "SD";
    }
    if name.contains("流畅") {
        return "LD";
    }
    match key.to_ascii_uppercase().as_str() {
        "ORIGIN" | "OD" => "OD",
        "FULL_HD1" | "BD" => "BD",
        "UHD" => "UHD",
        "HD1" | "HD" => "HD",
        "SD1" | "SD2" | "SD" => "SD",
        "LD" | "LD1" => "LD",
        _ => "",
    }
}

fn quality_rank(tag: &str) -> i64 {
    match tag {
        "OD" => 6,
        "BD" => 5,
        "UHD" => 4,
        "HD" => 3,
        "SD" => 2,
        "LD" => 1,
        _ => 0,
    }
}

fn append_stream(
    streams: &mut Vec<DouyinStream>,
    key: &str,
    name: &str,
    level: i64,
    format: &'static str,
    url: &Value,
) {
    let Some(url) = url
        .as_str()
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
    else {
        return;
    };
    if streams
        .iter()
        .any(|stream| stream.url == url && stream.format == format && stream.key == key)
    {
        return;
    }
    streams.push(DouyinStream {
        key: key.into(),
        name: name.into(),
        level,
        url: url.into(),
        format,
    });
}

/// 汇总房间的所有可用流：既包括 SDK 拉流数据（带 sdk_key 与 level），
/// 也包括传统的 flv/hls 拉流映射表。
fn collect_douyin_streams(room: &Value) -> Vec<DouyinStream> {
    let mut streams = Vec::new();
    let Some(stream_url) = room.get("stream_url") else {
        return streams;
    };
    let mut pulls = Vec::new();
    if let Some(data) = stream_url.pointer("/live_core_sdk_data/pull_data") {
        pulls.push(data);
    }
    if let Some(data) = stream_url.get("pull_datas").and_then(Value::as_object) {
        pulls.extend(data.values());
    }
    for pull in pulls {
        let Some(data) = pull
            .get("stream_data")
            .and_then(Value::as_str)
            .and_then(|data| serde_json::from_str::<Value>(data).ok())
        else {
            continue;
        };
        let Some(data) = data.get("data").and_then(Value::as_object) else {
            continue;
        };
        if let Some(qualities) = pull
            .pointer("/options/qualities")
            .or_else(|| stream_url.pointer("/live_core_sdk_data/pull_data/options/qualities"))
            .and_then(Value::as_array)
        {
            for quality in qualities {
                let Some(key) = quality.get("sdk_key").and_then(Value::as_str) else {
                    continue;
                };
                let Some(main) = data.get(key).and_then(|stream| stream.get("main")) else {
                    continue;
                };
                let name = quality.get("name").and_then(Value::as_str).unwrap_or(key);
                let level = quality
                    .get("level")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                for format in ["flv", "hls"] {
                    if let Some(url) = main.get(format) {
                        append_stream(&mut streams, key, name, level, format, url);
                    }
                }
            }
        } else {
            for (key, stream) in data {
                for format in ["flv", "hls"] {
                    if let Some(url) = stream.pointer(&format!("/main/{format}")) {
                        append_stream(
                            &mut streams,
                            key,
                            key,
                            quality_rank(quality_tag(key, key)),
                            format,
                            url,
                        );
                    }
                }
            }
        }
    }
    for (map_name, format) in [("flv_pull_url", "flv"), ("hls_pull_url_map", "hls")] {
        if let Some(map) = stream_url.get(map_name).and_then(Value::as_object) {
            for (key, url) in map {
                let tag = quality_tag(key, key);
                if !streams.iter().any(|stream| {
                    stream.format == format
                        && (if tag.is_empty() {
                            stream.key == *key
                        } else {
                            quality_tag(&stream.key, &stream.name) == tag
                        })
                }) {
                    append_stream(&mut streams, key, key, quality_rank(tag), format, url);
                }
            }
        }
    }
    // 清晰度顺序来自接口 level，同一画质中 FLV 先于 HLS。
    streams.sort_by(|a, b| b.level.cmp(&a.level).then_with(|| a.format.cmp(b.format)));
    streams
}

pub fn normalize_quality_tag(input: &str) -> &'static str {
    match input.trim().to_ascii_uppercase().as_str() {
        "BD" => "BD",
        "UHD" => "UHD",
        "HD" => "HD",
        "SD" => "SD",
        "LD" => "LD",
        _ => "OD",
    }
}

/// 只返回实际选中的同一画质候选；主地址为第一项，保留 FLV/HLS 的原始 URL。
pub fn streams_for_quality(room: &Value, desired_quality: &str) -> Vec<DouyinStream> {
    let streams = collect_douyin_streams(room);
    let desired = normalize_quality_tag(desired_quality);
    let selected = streams
        .iter()
        .find(|stream| quality_tag(&stream.key, &stream.name) == desired)
        .or_else(|| streams.first());
    let Some(selected) = selected else {
        return Vec::new();
    };
    let tag = quality_tag(&selected.key, &selected.name);
    let key = selected.key.clone();
    let mut selected = streams
        .into_iter()
        .filter(|stream| {
            if tag.is_empty() {
                stream.key == key
            } else {
                quality_tag(&stream.key, &stream.name) == tag
            }
        })
        .collect::<Vec<_>>();
    selected.sort_by(|a, b| a.format.cmp(b.format));
    selected
}

pub fn choose_flv_stream(room: &Value, desired_quality: &str) -> Option<(String, String)> {
    streams_for_quality(room, desired_quality)
        .into_iter()
        .next()
        .map(|stream| (stream.key, stream.url))
}

#[cfg(test)]
mod douyin_quality_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quality_is_selected_by_stream_key_not_map_order() {
        // 键的字典序是 HD1 < ORIGIN < SD1，按迭代位置选会挑错画质。
        let room = json!({"stream_url": {"flv_pull_url": {
            "HD1": "http://cdn/hd.flv",
            "ORIGIN": "http://cdn/origin.flv",
            "SD1": "http://cdn/sd.flv"
        }}});
        assert_eq!(
            choose_flv_stream(&room, "OD").unwrap().1,
            "http://cdn/origin.flv"
        );
        assert_eq!(choose_flv_stream(&room, "HD").unwrap().1, "http://cdn/hd.flv");
        assert_eq!(choose_flv_stream(&room, "SD").unwrap().1, "http://cdn/sd.flv");
    }

    #[test]
    fn sdk_pull_data_is_mapped_by_sdk_key_and_keeps_original_url() {
        let stream_data = json!({
            "data": {
                "origin": {"main": {"flv": "http://cdn/origin.flv"}},
                "hd": {"main": {"flv": "http://cdn/hd.flv"}}
            }
        })
        .to_string();
        let room = json!({"stream_url": {"live_core_sdk_data": {"pull_data": {
            "stream_data": stream_data,
            "options": {"qualities": [
                {"sdk_key": "origin", "name": "原画", "level": 5},
                {"sdk_key": "hd", "name": "高清", "level": 3}
            ]}
        }}}});
        assert_eq!(
            choose_flv_stream(&room, "OD").unwrap().1,
            "http://cdn/origin.flv"
        );
        assert_eq!(choose_flv_stream(&room, "HD").unwrap().1, "http://cdn/hd.flv");
        // 未知画质回落默认原画，但不能丢掉其他已知画质。
        assert_eq!(
            choose_flv_stream(&room, "ZZ").unwrap().1,
            "http://cdn/origin.flv"
        );
    }

    #[test]
    fn unavailable_quality_falls_back_to_best_available_stream() {
        let room = json!({"stream_url": {"flv_pull_url": {
            "ORIGIN": "http://cdn/origin.flv"
        }}});
        assert_eq!(
            choose_flv_stream(&room, "LD").unwrap().1,
            "http://cdn/origin.flv"
        );
    }

    #[test]
    fn missing_room_status_is_an_interface_error_not_offline() {
        for room in [
            json!({}),
            json!({"status": "blocked"}),
            json!({"status": null}),
        ] {
            assert!(room_status(&room).is_err());
        }
        assert_eq!(room_status(&json!({"status": 2})).unwrap(), 2);
        assert_eq!(room_status(&json!({"status": 4})).unwrap(), 4);
    }
}

#[cfg(test)]
mod douyin_room_tests {
    use super::*;
    use serde_json::json;

    /// 还原 `self.__pace_f.push([n, "..."]);` 的网页内嵌状态片段。
    fn room_page(room: Value, anchor: Value) -> String {
        let payload = json!({
            "state": {"roomStore": {"roomInfo": {"room": room, "anchor": anchor}}}
        })
        .to_string();
        // 外层是 JSON 字符串字面量，因此要对内嵌 JSON 再编码一次。
        let chunk = serde_json::to_string(&payload).unwrap();
        format!(r#"<script>self.__pace_f.push([1,{chunk}])</script>"#)
    }

    #[test]
    fn web_page_fallback_reads_next_and_pace_chunks_without_truncating_title() {
        let html = room_page(
            json!({"status": 2, "title": "带 \"引号\" 与 } 的标题"}),
            json!({"nickname": "主播"}),
        )
        .replace("__pace_f", "__next_f");
        let data = parse_room_html(&html).unwrap();
        assert_eq!(data.room["status"], 2);
        assert_eq!(data.room["title"], "带 \"引号\" 与 } 的标题");
        assert_eq!(data.room["anchor"]["nickname"], "主播");
    }

    #[test]
    fn web_page_without_room_info_is_an_error() {
        assert!(parse_room_html("<html><body>verify</body></html>").is_err());
        let html = room_page(json!({"title": "无状态"}), json!({}));
        assert!(parse_room_html(&html).is_err());
    }

    #[test]
    fn share_links_prefer_stable_web_rid_and_keep_long_room_id() {
        assert_eq!(normalize_douyin_live_id("https://live.douyin.com/123456"), "123456");
        assert_eq!(
            normalize_douyin_live_id("https://www.douyin.com/root/live/987654?foo=1"),
            "987654"
        );
        assert_eq!(
            normalize_douyin_live_id("https://www.douyin.com/?room_id=999&web_rid=abc"),
            "abc"
        );
        assert_eq!(normalize_douyin_live_id("7012345678901234567"), "7012345678901234567");
        assert_eq!(normalize_douyin_live_id("  "), "");
    }

    #[test]
    fn room_web_rid_accepts_string_and_numeric_ids() {
        assert_eq!(
            room_web_rid(&json!({"owner": {"web_rid": "555"}})).as_deref(),
            Some("555")
        );
        assert_eq!(
            room_web_rid(&json!({"anchor": {"web_rid": 666}})).as_deref(),
            Some("666")
        );
        assert!(room_web_rid(&json!({"owner": {"web_rid": ""}})).is_none());
    }

    #[test]
    fn session_merge_keeps_account_fields_and_only_accepts_guest_cookies() {
        let mut updates = HeaderMap::new();
        updates.append(SET_COOKIE, HeaderValue::from_static("ttwid=abc; Path=/; HttpOnly"));
        updates.append(SET_COOKIE, HeaderValue::from_static("sessionid=should_be_ignored; Path=/"));
        assert_eq!(
            merge_cookies(Some("uid=9; ttwid=old"), &updates),
            "ttwid=abc; uid=9"
        );
        assert_eq!(merge_cookies(None, &HeaderMap::new()), "");
    }
}
