use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;
use tauri::{command, AppHandle, State};

use crate::platforms::common::types::StreamVariant;
use crate::proxy::{start_proxy, ProxyServerHandle};
use crate::StreamUrlStore;

#[command]
pub async fn get_bilibili_live_stream_url_with_quality(
    app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
    proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: crate::platforms::common::GetStreamUrlPayload,
    quality: String,
    cookie: Option<String>,
    line: Option<usize>,
) -> Result<crate::platforms::common::LiveStreamInfo, String> {
    let room_id = payload.args.room_id_str.clone();
    if room_id.trim().is_empty() {
        return Ok(crate::platforms::common::LiveStreamInfo {
            title: None,
            anchor_name: None,
            avatar: None,
            stream_url: None,
            status: None,
            error_message: Some("房间ID未提供".to_string()),
            upstream_url: None,
            available_streams: None,
            normalized_room_id: None,
            web_rid: None,
        });
    }

    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

    // Build headers
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_str(ua).unwrap());
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://live.bilibili.com/"),
    );
    if let Some(c) = cookie.as_ref() {
        let c_trimmed = c.trim();
        if !c_trimmed.is_empty() {
            match HeaderValue::from_str(c_trimmed) {
                Ok(val) => {
                    headers.insert(COOKIE, val);
                    eprintln!("[Bilibili] Cookie header set (content hidden)");
                }
                Err(err) => {
                    eprintln!("[Bilibili] Invalid cookie header, skipping. Error: {}", err);
                }
            }
        } else {
            eprintln!("[Bilibili] Cookie provided is empty after trimming, skipping insertion.");
        }
    }

    // 添加必要的 Origin，以符合部分接口对 CSRF 的检查
    headers.insert(
        reqwest::header::ORIGIN,
        HeaderValue::from_static("https://live.bilibili.com"),
    );
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .http1_only()
        .connect_timeout(std::time::Duration::from_secs(15))
        // connect_timeout 只管 TCP/TLS 握手；连上之后响应体可以无限期挂住。
        // 弱网下对端只收不发就会永久占用这个请求（看门狗作废会话后重取流会不断堆叠），
        // 所以这里必须补上整体 timeout。
        .timeout(std::time::Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    // Helper: request playinfo with optional qn
    async fn request_playinfo(
        client: &reqwest::Client,
        room_id: &str,
        qn: Option<i32>,
    ) -> Result<Value, String> {
        let url = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo";
        let mut params = vec![
            ("room_id", room_id.to_string()),
            ("protocol", "0,1".to_string()),
            ("format", "0,1,2".to_string()),
            // 同时取得 AVC 与 HEVC，使用网页端取流协议
            ("codec", "0,1".to_string()),
            ("platform", "web".to_string()),
            ("dolby", "5".to_string()),
        ];
        if let Some(q) = qn {
            params.push(("qn", q.to_string()));
        }
        let resp = client
            .get(url)
            .query(&params)
            .send()
            .await
            .map_err(|e| format!("PlayInfo request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Read text failed: {}", e))?;
        if !status.is_success() {
            return Err(format!("PlayInfo status: {} body: {}", status, text));
        }
        let json = serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("JSON parse failed: {} | body: {}", e, text))?;
        check_bilibili_response(&json, "PlayInfo")?;
        Ok(json)
    }

    // 先确认开播状态：未开播时直接返回，不必再发取流请求。
    let room_init_url = format!(
        "https://api.live.bilibili.com/room/v1/Room/room_init?id={}",
        room_id
    );
    let init_resp = client
        .get(&room_init_url)
        .send()
        .await
        .map_err(|e| format!("room_init failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("room_init HTTP failed: {}", e))?;
    let init_text = init_resp
        .text()
        .await
        .map_err(|e| format!("room_init read text failed: {}", e))?;
    let init_json: Value = serde_json::from_str(&init_text)
        .map_err(|e| format!("room_init json failed: {} | {}", e, init_text))?;
    check_bilibili_response(&init_json, "room_init")?;
    let live_status = bilibili_live_status(&init_json)?;
    if live_status != 1 {
        return Ok(crate::platforms::common::LiveStreamInfo {
            title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
            anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
            avatar: None,
            stream_url: None,
            status: Some(0),
            error_message: None,
            upstream_url: None,
            available_streams: None,
            normalized_room_id: None,
            web_rid: None,
        });
    }

    // 1) First request to get qn mapping
    let playinfo = request_playinfo(&client, &room_id, None).await?;
    let playurl = playinfo["data"]["playurl_info"]["playurl"].clone();

    // Build qn->desc map
    let mut qn_map: Vec<(i32, String)> = vec![];
    if let Some(arr) = playurl.get("g_qn_desc").and_then(|v| v.as_array()) {
        for item in arr {
            let qn = item.get("qn").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let desc = item
                .get("desc")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            qn_map.push((qn, desc));
        }
    }
    // 解析 accept_qn（首个 stream/format/codec 的可选清晰度）
    let mut accept_qn: Vec<i32> = vec![];
    if let Some(streams) = playurl.get("stream").and_then(|v| v.as_array()) {
        if let Some(first_format) = streams
            .get(0)
            .and_then(|s| s.get("format"))
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.get(0))
        {
            if let Some(first_codec) = first_format
                .get("codec")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.get(0))
            {
                if let Some(arr) = first_codec.get("accept_qn").and_then(|v| v.as_array()) {
                    for q in arr {
                        if let Some(i) = q.as_i64() {
                            accept_qn.push(i as i32);
                        }
                    }
                }
            }
        }
    }
    // 调试输出：可用的 qn 列表及描述 + accept_qn
    if !qn_map.is_empty() {
        let qn_str = qn_map
            .iter()
            .map(|(q, d)| format!("{}:{}", q, d))
            .collect::<Vec<_>>()
            .join(", ");
        eprintln!("[Bilibili] qn_map for room {} => [{}]", room_id, qn_str);
    } else {
        eprintln!("[Bilibili] qn_map is empty for room {}", room_id);
    }
    if !accept_qn.is_empty() {
        let accept_str = accept_qn
            .iter()
            .map(|q| q.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        eprintln!("[Bilibili] accept_qn => [{}]", accept_str);
    }

    // Choose qn by desired quality text（更严格的匹配与优先规则）
    fn match_qn(qn_map: &[(i32, String)], quality: &str) -> Option<i32> {
        let q = quality.trim();
        let mut qns: Vec<i32> = qn_map.iter().map(|(qn, _)| *qn).collect();
        qns.sort();
        let has = |v: i32| qns.binary_search(&v).is_ok();

        match q {
            "原画" => {
                if has(10000) {
                    Some(10000)
                } else {
                    qns.last().copied()
                }
            }
            "高清" => {
                // 优先固定值 400；否则按描述关键字匹配（高清/超清/HD）；再兜底选择次高值
                if has(400) {
                    return Some(400);
                }
                for (qn, desc) in qn_map.iter() {
                    if desc.contains("高清") || desc.contains("超清") || desc.contains("HD") {
                        return Some(*qn);
                    }
                }
                // 兜底：选择小于最大值的次高 qn（例如只有 10000 和 250 时，选 250）
                let max = qns.last().copied();
                if let Some(m) = max {
                    qns.into_iter().rev().find(|&x| x < m)
                } else {
                    None
                }
            }
            "标清" => {
                // 优先固定值 250；否则按描述关键字匹配（标清/流畅/SD）；再兜底选择最小值
                if has(250) {
                    return Some(250);
                }
                for (qn, desc) in qn_map.iter() {
                    if desc.contains("标清") || desc.contains("流畅") || desc.contains("SD") {
                        return Some(*qn);
                    }
                }
                qns.first().copied()
            }
            _ => {
                // 未识别文案：兜底最大值
                qns.last().copied()
            }
        }
    }

    let selected_qn = match_qn(&qn_map, &quality);
    let selected_desc = selected_qn.and_then(|qn| {
        qn_map
            .iter()
            .find(|(q, _)| *q == qn)
            .map(|(_, d)| d.clone())
    });
    eprintln!(
        "[Bilibili] selected quality '{}' -> qn={:?}, desc={:?}",
        quality, selected_qn, selected_desc
    );

    enum SelectedStream {
        Flv(String),
        Hls(String),
    }

    // 取流不再串行探测 CDN：一次性拿到该画质的全部候选，由前端按索引切换失败线路。
    let playinfo_selected = request_playinfo(&client, &room_id, selected_qn).await?;
    let selected_live_status = bilibili_live_status(&playinfo_selected)?;
    let variants_for_response = parse_stream_variants(
        &playinfo_selected["data"]["playurl_info"]["playurl"],
        &selected_desc,
        selected_qn,
    );
    let selected_stream = if selected_live_status == 1 {
        select_stream_variant(&variants_for_response, line).map(|variant| {
            if variant.format.as_deref() == Some("flv") {
                SelectedStream::Flv(variant.url.clone())
            } else {
                SelectedStream::Hls(variant.url.clone())
            }
        })
    } else {
        None
    };

    let selected_stream = match selected_stream {
        Some(stream) => stream,
        None => {
            return Ok(crate::platforms::common::LiveStreamInfo {
                title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
                anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
                avatar: None,
                stream_url: None,
                status: Some(if selected_live_status == 1 { 2 } else { 0 }),
                error_message: if selected_live_status == 1 {
                    Some("未找到可用的直播流地址".to_string())
                } else {
                    None
                },
                upstream_url: None,
                available_streams: Some(variants_for_response),
                normalized_room_id: None,
                web_rid: None,
            });
        }
    };

    match selected_stream {
        SelectedStream::Flv(real_url) => {
            // FLV：写入到 Store 并启动代理
            let proxied_url = {
                {
                    let mut current_url_in_store = stream_url_store.url.lock().unwrap();
                    *current_url_in_store = real_url.clone();
                }
                match start_proxy(app_handle, proxy_server_handle, stream_url_store).await {
                    Ok(proxy) => Some(proxy),
                    Err(e) => {
                        eprintln!("[Bilibili] Failed to start proxy: {}", e);
                        None
                    }
                }
            };

            let final_error_message = if proxied_url.is_none() {
                Some("代理启动失败".to_string())
            } else {
                None
            };

            Ok(crate::platforms::common::LiveStreamInfo {
                title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
                anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
                avatar: None,
                stream_url: proxied_url,
                status: Some(if final_error_message.is_some() { 2 } else { 1 }),
                error_message: final_error_message,
                upstream_url: Some(real_url),
                available_streams: Some(variants_for_response.clone()),
                normalized_room_id: None,
                web_rid: None,
            })
        }
        SelectedStream::Hls(real_url) => {
            // HLS：无需本地代理，若存在旧的 FLV 代理则关闭并清空存储
            {
                let handle_to_stop = { proxy_server_handle.0.lock().unwrap().take() };
                if let Some(handle) = handle_to_stop {
                    handle.stop(false).await;
                    eprintln!("[Bilibili] Stopped existing FLV proxy before using HLS stream");
                }
            }
            {
                let mut current_url_in_store = stream_url_store.url.lock().unwrap();
                *current_url_in_store = String::new();
            }

            Ok(crate::platforms::common::LiveStreamInfo {
                title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
                anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
                avatar: None,
                stream_url: Some(real_url.clone()),
                status: Some(1),
                error_message: None,
                upstream_url: Some(real_url),
                available_streams: Some(variants_for_response),
                normalized_room_id: None,
                web_rid: None,
            })
        }
    }
}

/// B 站接口用 code/message 表达业务错误。把它当普通响应解析会让
/// “接口错误”退化成“没有流地址”，最终被上层误判成主播未开播。
fn check_bilibili_response(json: &Value, api: &str) -> Result<(), String> {
    let code = json
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{} 响应缺少业务状态码", api))?;
    if code != 0 {
        let message = json
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("接口错误");
        return Err(format!("{} 错误 {}：{}", api, code, message));
    }
    Ok(())
}

fn bilibili_live_status(json: &Value) -> Result<i64, String> {
    match json["data"]["live_status"].as_i64() {
        Some(status @ 0..=2) => Ok(status),
        _ => Err("B站响应缺少有效直播状态".to_string()),
    }
}

/// 收集该画质下的全部候选流：跳过非法地址、按 AVC 优先排序、
/// 普通 CDN 保持接口顺序而 mcdn 只作备用。
fn parse_stream_variants(
    playurl: &Value,
    selected_desc: &Option<String>,
    selected_qn: Option<i32>,
) -> Vec<StreamVariant> {
    let mut variants = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(streams) = playurl.get("stream").and_then(Value::as_array) {
        for stream in streams {
            let protocol = stream
                .get("protocol_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Some(formats) = stream.get("format").and_then(Value::as_array) {
                for format in formats {
                    let format_name = format
                        .get("format_name")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !matches!(format_name, "flv" | "ts" | "fmp4" | "mp4" | "m4s" | "m3u8") {
                        continue;
                    }
                    if let Some(codecs) = format.get("codec").and_then(Value::as_array) {
                        // xgplayer 对 HEVC 的支持不稳定，avc 必须排在前面。
                        let mut codecs: Vec<_> = codecs.iter().collect();
                        codecs.sort_by_key(|codec| codec["codec_name"].as_str() != Some("avc"));
                        for codec in codecs {
                            let base = codec.get("base_url").and_then(Value::as_str).unwrap_or("");
                            if base.is_empty() {
                                continue;
                            }
                            if let Some(infos) = codec.get("url_info").and_then(Value::as_array) {
                                for info in infos {
                                    let host =
                                        info.get("host").and_then(Value::as_str).unwrap_or("");
                                    let extra =
                                        info.get("extra").and_then(Value::as_str).unwrap_or("");
                                    let composed = format!("{}{}{}", host, base, extra);
                                    let valid = url::Url::parse(&composed)
                                        .map(|url| {
                                            matches!(url.scheme(), "http" | "https")
                                                && url.host_str().is_some()
                                        })
                                        .unwrap_or(false);
                                    if !valid || !seen.insert(composed.clone()) {
                                        continue;
                                    }
                                    variants.push(StreamVariant {
                                        url: composed,
                                        format: Some(format_name.to_string()),
                                        desc: selected_desc.clone(),
                                        qn: selected_qn,
                                        protocol: if protocol.is_empty() {
                                            None
                                        } else {
                                            Some(protocol.to_string())
                                        },
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    variants.sort_by_key(|variant| variant.url.contains("mcdn"));
    variants
}

fn select_stream_variant(
    variants: &[StreamVariant],
    line: Option<usize>,
) -> Option<&StreamVariant> {
    variants.get(line.unwrap_or(0)).or_else(|| variants.first())
}

#[cfg(test)]
mod bilibili_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ordinary_cdns_keep_api_order_and_mcdn_is_deduplicated_backup() {
        let playurl = json!({"stream": [{"protocol_name": "http_stream", "format": [{"format_name": "flv", "codec": [{"codec_name": "avc", "base_url": "/live.flv", "url_info": [
            {"host": "http://mcdn.example.com", "extra": ""},
            {"host": "http://z.example.com", "extra": ""},
            {"host": "http://a.example.com", "extra": ""},
            {"host": "http://z.example.com", "extra": ""}
        ]}]}]}]});
        let variants = parse_stream_variants(&playurl, &None, Some(10000));
        assert_eq!(
            variants.iter().map(|v| v.url.as_str()).collect::<Vec<_>>(),
            vec![
                "http://z.example.com/live.flv",
                "http://a.example.com/live.flv",
                "http://mcdn.example.com/live.flv"
            ]
        );
    }

    #[test]
    fn avc_precedes_hevc_without_discarding_backup() {
        let playurl = json!({"stream": [{"protocol_name": "http_stream", "format": [{"format_name": "flv", "codec": [
            {"codec_name": "hevc", "base_url": "/hevc.flv", "url_info": [{"host": "https://hevc.example.com", "extra": ""}]},
            {"codec_name": "avc", "base_url": "/avc.flv", "url_info": [{"host": "https://avc.example.com", "extra": ""}]}
        ]}]}]});
        let variants = parse_stream_variants(&playurl, &None, Some(10000));
        assert_eq!(
            variants.iter().map(|v| v.url.as_str()).collect::<Vec<_>>(),
            vec![
                "https://avc.example.com/avc.flv",
                "https://hevc.example.com/hevc.flv"
            ]
        );
    }

    #[test]
    fn api_errors_and_missing_live_status_are_not_offline() {
        assert!(
            check_bilibili_response(&json!({"code": -400, "message": "请求失败"}), "PlayInfo")
                .is_err()
        );
        assert!(check_bilibili_response(&json!({}), "room_init").is_err());
        assert!(check_bilibili_response(&json!({"code": 0}), "PlayInfo").is_ok());
        assert!(bilibili_live_status(&json!({"data": {}})).is_err());
        assert!(bilibili_live_status(&json!({"data": {"live_status": 9}})).is_err());
        assert_eq!(
            bilibili_live_status(&json!({"data": {"live_status": 0}})).unwrap(),
            0
        );
        assert_eq!(
            bilibili_live_status(&json!({"data": {"live_status": 1}})).unwrap(),
            1
        );
        assert_eq!(
            bilibili_live_status(&json!({"data": {"live_status": 2}})).unwrap(),
            2
        );
    }

    #[test]
    fn line_index_selects_hls_and_preserves_quality_metadata() {
        let playurl = json!({"stream": [
            {"protocol_name": "http_stream", "format": [{"format_name": "flv", "codec": [{"codec_name": "avc", "base_url": "/live.flv", "url_info": [{"host": "http://flv.example.com", "extra": "?token=1"}]}]}]},
            {"protocol_name": "http_hls", "format": [{"format_name": "fmp4", "codec": [{"codec_name": "avc", "base_url": "/live.m3u8", "url_info": [{"host": "http://hls.example.com", "extra": "?token=2"}]}]}]}
        ]});
        let variants = parse_stream_variants(&playurl, &Some("高清".into()), Some(400));
        let selected = select_stream_variant(&variants, Some(1)).unwrap();
        assert_eq!(selected.url, "http://hls.example.com/live.m3u8?token=2");
        assert_eq!(selected.format.as_deref(), Some("fmp4"));
        assert_eq!(selected.protocol.as_deref(), Some("http_hls"));
        assert_eq!(selected.desc.as_deref(), Some("高清"));
        assert_eq!(selected.qn, Some(400));
        assert_eq!(
            select_stream_variant(&variants, None).unwrap().url,
            "http://flv.example.com/live.flv?token=1"
        );
        assert_eq!(
            select_stream_variant(&variants, Some(99)).unwrap().url,
            "http://flv.example.com/live.flv?token=1"
        );
        assert!(select_stream_variant(&[], Some(0)).is_none());
    }

    #[test]
    fn malformed_candidates_do_not_hide_valid_urls() {
        let playurl = json!({"stream": [{"protocol_name": "http_stream", "format": [{"format_name": "flv", "codec": [
            {"base_url": "/live.flv", "url_info": [{"host": "null", "extra": ""}, {"host": "", "extra": ""}, {"host": "https://valid.example.com", "extra": ""}]},
            {"base_url": "", "url_info": [{"host": "https://empty.example.com", "extra": ""}]}
        ]}]}]});
        let variants = parse_stream_variants(&playurl, &None, None);
        assert_eq!(
            variants.iter().map(|v| v.url.as_str()).collect::<Vec<_>>(),
            vec!["https://valid.example.com/live.flv"]
        );
    }
}
