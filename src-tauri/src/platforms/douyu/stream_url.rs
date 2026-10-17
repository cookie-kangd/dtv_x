use deno_core::{JsRuntime, RuntimeOptions};
use html_escape::decode_html_entities;
use reqwest::{
    header::{HeaderMap, HeaderValue},
    redirect::Policy,
    Client,
};
use serde::Deserialize;
use serde_json::Value;
#[cfg(target_os = "linux")]
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Debug)]
struct BetardRoomInfo {
    room_id: Option<Value>,
    show_status: Option<Value>,
    #[serde(rename = "videoLoop")]
    video_loop: Option<Value>,
}

#[derive(Deserialize, Debug)]
struct BetardResponse {
    room: Option<BetardRoomInfo>,
}

#[derive(Clone, Debug)]
struct DouyuPlayInfo {
    variants: Vec<DouyuRateVariant>,
    cdns: Vec<String>,
}

#[derive(Clone, Debug)]
struct DouyuRateVariant {
    name: String,
    rate: i32,
    bit: Option<i32>,
}

fn value_to_i32(value: &Value) -> Option<i32> {
    match value {
        Value::Number(num) => num.as_i64().map(|n| n as i32),
        Value::String(s) => s.parse::<i32>().ok(),
        _ => None,
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::Number(num) => Some(num.to_string()),
        Value::String(s) => Some(s.to_string()),
        _ => None,
    }
}

struct DouYu {
    did: String,
    rid: String,
    client: Client,
}

const DEFAULT_DOUYU_CDN: &str = "ws-h5";
const DEFAULT_DOUYU_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
const DEFAULT_DOUYU_DID: &str = "10000000000000000000000000001501";
const CRYPTO_JS: &str = include_str!("cryptojs.min.js");

#[cfg(target_os = "linux")]
static JS_RUNTIME_INIT: Once = Once::new();

fn ensure_js_runtime_platform_initialized() {
    #[cfg(target_os = "linux")]
    JS_RUNTIME_INIT.call_once(|| {
        JsRuntime::init_platform(None);
    });
}

fn normalize_douyu_cdn(input: Option<&str>) -> &'static str {
    match input
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .as_deref()
    {
        Some("ws-h5") => "ws-h5",
        Some("tct-h5") => "tct-h5",
        Some("ali-h5") => "ali-h5",
        Some("hs-h5") => "hs-h5",
        _ => DEFAULT_DOUYU_CDN,
    }
}

impl DouYu {
    async fn new(rid: &str) -> Result<Self, Box<dyn std::error::Error>> {
        // 迁移到 reqwest：禁用系统代理、限制重定向、设置默认 UA/语言等头部
        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            "User-Agent",
            HeaderValue::from_static(DEFAULT_DOUYU_UA),
        );
        default_headers.insert(
            "Accept-Language",
            HeaderValue::from_static("zh-CN,zh;q=0.9"),
        );
        // ★ 必须设总超时：全仓库20+ 处 Client::builder() 都带 connect_timeout + timeout，
        //   唯独斗鱼取流这条最关键的路径漏了。reqwest 的两个超时默认都是 None，
        //   服务端不回数据时这条命令会**永不返回** → 前端 await 永久挂住 →
        //   20s 后被看门狗作废会话 → 自动重连又新建一个 Client（带独立连接池与挂死 socket）。
        //   反复重连会让这些挂死请求持续堆积，白白吃内存和带宽。
        let client = Client::builder()
            .redirect(Policy::limited(10))
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(20))
            .default_headers(default_headers)
            .build()?;

        Ok(Self {
            did: DEFAULT_DOUYU_DID.to_string(),
            rid: rid.to_string(),
            client,
        })
    }

    async fn execute_js_sign(
        &self,
        script: &str,
        rid: &str,
        did: &str,
        ts: i64,
    ) -> Result<String, Box<dyn std::error::Error>> {
        ensure_js_runtime_platform_initialized();
        let mut runtime = JsRuntime::new(RuntimeOptions::default());

        runtime.execute_script(
            "[douyu]",
            deno_core::FastString::from(String::from(CRYPTO_JS)),
        )?;
        runtime.execute_script("[douyu]", deno_core::FastString::from(script.to_string()))?;

        let rid_js = serde_json::to_string(rid)?;
        let did_js = serde_json::to_string(did)?;
        let call_expr = format!("ub98484234({rid_js},{did_js},{ts});");
        let js_result =
            runtime.execute_script("[douyu]", deno_core::FastString::from(call_expr))?;

        let params = {
            let scope = &mut runtime.handle_scope();
            let result = js_result.open(scope);
            result.to_rust_string_lossy(scope)
        };

        Ok(params)
    }

    async fn fetch_room_detail(&self) -> Result<(String, bool), Box<dyn std::error::Error>> {
        let url = format!("https://www.douyu.com/betard/{}", self.rid);
        let json = self
            .client
            .get(url)
            .header("Referer", format!("https://www.douyu.com/{}", self.rid))
            .send()
            .await?
            .error_for_status()?
            .json::<BetardResponse>()
            .await?;

        let room = json.room.ok_or("Missing room data")?;
        let room_id_value = room.room_id.ok_or("Missing room_id")?;
        let room_id = value_to_string(&room_id_value).ok_or("Invalid room_id")?;
        // 状态字段缺失说明接口异常，不能默认成「没开播」。
        let show_status = room
            .show_status
            .as_ref()
            .and_then(value_to_i32)
            .ok_or("房间响应缺少有效直播状态")?;
        // videoLoop=1 是轮播（重播录像），不算直播中。
        let is_record = room.video_loop.as_ref().and_then(value_to_i32) == Some(1);
        Ok((room_id, show_status == 1 && !is_record))
    }

    async fn get_h5_enc(&self, room_id: &str) -> Result<String, Box<dyn std::error::Error>> {
        let url = format!("https://www.douyu.com/swf_api/homeH5Enc?rids={}", room_id);
        let json = self
            .client
            .get(url)
            .header("Referer", format!("https://www.douyu.com/{}", room_id))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;

        let error_code = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error_code != 0 {
            return Err(format!("homeH5Enc error: {}", error_code).into());
        }

        let key = format!("room{}", room_id);
        let crptext = json
            .get("data")
            .and_then(|v| v.get(&key))
            .and_then(|v| v.as_str())
            .ok_or("Missing homeH5Enc data")?;
        Ok(crptext.to_string())
    }

    async fn build_sign_params(
        &self,
        room_id: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let crptext = self.get_h5_enc(room_id).await?;
        let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
        let params = self
            .execute_js_sign(&crptext, room_id, &self.did, ts)
            .await?;
        Ok(params)
    }

    async fn get_play_qualities(
        &self,
        room_id: &str,
        sign_data: &str,
    ) -> Result<DouyuPlayInfo, Box<dyn std::error::Error>> {
        let payload = format!(
            "{}&cdn=&rate=-1&ver=Douyu_223061205&iar=1&ive=1&hevc=0&fa=0",
            sign_data
        );
        let url = format!("https://www.douyu.com/lapi/live/getH5Play/{}", room_id);
        let json = self
            .client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(payload)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;

        let error_code = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error_code != 0 {
            let msg = json
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or("getH5Play failed");
            return Err(format!("getH5Play error {}: {}", error_code, msg).into());
        }

        let data = json.get("data").ok_or("No data field in response")?;
        let cdns = data
            .get("cdnsWithName")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        item.get("cdn")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        let cdns_sorted = order_cdns(cdns);

        let variants = data
            .get("multirates")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())?;
                        let rate_value = item.get("rate").and_then(value_to_i32)?;
                        let bit_value = item.get("bit").and_then(value_to_i32);
                        Some(DouyuRateVariant {
                            name,
                            rate: rate_value,
                            bit: bit_value,
                        })
                    })
                    .collect::<Vec<DouyuRateVariant>>()
            })
            .unwrap_or_default();

        Ok(DouyuPlayInfo {
            variants,
            cdns: cdns_sorted,
        })
    }

    async fn get_play_url(
        &self,
        room_id: &str,
        sign_data: &str,
        rate: i32,
        cdn: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let payload = format!("{}&cdn={}&rate={}", sign_data, cdn, rate);
        let url = format!("https://www.douyu.com/lapi/live/getH5Play/{}", room_id);
        let json = self
            .client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Referer", format!("https://www.douyu.com/{}", room_id))
            .body(payload)
            // 单线路及时超时，给播放器看门狗之前的备用线路请求留出时间。
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;

        let error_code = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error_code != 0 {
            let msg = json
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or("getH5Play failed");
            return Err(format!("getH5Play error {}: {}", error_code, msg).into());
        }

        let data = json.get("data").ok_or("No data field in response")?;
        compose_douyu_url(data)
    }

    async fn get_play_url_with_fallback(
        &self,
        room_id: &str,
        sign_data: &str,
        rate: i32,
        requested: Option<&str>,
        available: &[String],
        candidate_index: Option<usize>,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let cdns = cdn_candidates(requested, available, candidate_index);
        first_playable_url(&cdns, |cdn| async move {
            self.get_play_url(room_id, sign_data, rate, &cdn).await
        })
        .await
    }

    pub async fn get_real_url(&self, cdn: Option<&str>) -> Result<String, Box<dyn std::error::Error>> {
        let (real_room_id, is_live) = self.fetch_room_detail().await?;
        if !is_live {
            return Err(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                "主播未开播",
            )));
        }

        let sign_data = self.build_sign_params(&real_room_id).await?;
        let play_info = self.get_play_qualities(&real_room_id, &sign_data).await?;
        let best_rate = play_info
            .variants
            .iter()
            .map(|variant| variant.rate)
            .max()
            .unwrap_or(0);
        self.get_play_url_with_fallback(
            &real_room_id,
            &sign_data,
            best_rate,
            cdn,
            &play_info.cdns,
            None,
        )
            .await
    }

    pub async fn get_real_url_with_quality(
        &self,
        quality: &str,
        cdn: Option<&str>,
        candidate_index: Option<usize>,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let (real_room_id, is_live) = self.fetch_room_detail().await?;
        if !is_live {
            return Err(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                "主播未开播",
            )));
        }

        let sign_data = self.build_sign_params(&real_room_id).await?;
        let play_info = self.get_play_qualities(&real_room_id, &sign_data).await?;
        let selected_rate = Self::resolve_rate_for_quality(quality, &play_info.variants)
            .or_else(|| play_info.variants.iter().map(|v| v.rate).max())
            .unwrap_or(0);
        println!(
            "[Douyu Stream URL] Requested quality '{}', resolved rate {} (variants: {:?})",
            quality, selected_rate, play_info.variants
        );
        self.get_play_url_with_fallback(
            &real_room_id,
            &sign_data,
            selected_rate,
            cdn,
            &play_info.cdns,
            candidate_index,
        )
        .await
    }

    fn resolve_rate_for_quality(quality: &str, variants: &[DouyuRateVariant]) -> Option<i32> {
        if variants.is_empty() {
            return None;
        }

        let trimmed = quality.trim();
        let ascii_lower = trimmed.to_ascii_lowercase();
        let canonical = if trimmed.contains('原') || ascii_lower == "origin" {
            "原画"
        } else if trimmed.contains('高') || ascii_lower == "high" {
            "高清"
        } else if trimmed.contains('标') || ascii_lower == "standard" {
            "标清"
        } else {
            trimmed
        };

        let find_by_keywords = |keywords: &[&str], exclude_zero: bool| -> Option<i32> {
            for keyword in keywords {
                if let Some(item) = variants.iter().find(|v| v.name.contains(keyword)) {
                    if exclude_zero && item.rate == 0 {
                        continue;
                    }
                    return Some(item.rate);
                }
            }
            None
        };

        match canonical {
            "原画" => {
                if let Some(item) = variants.iter().find(|v| v.rate == 0) {
                    return Some(item.rate);
                }
                if let Some(rate) = find_by_keywords(&["原画", "蓝光8M", "蓝光"], false) {
                    return Some(rate);
                }
                variants.iter().map(|v| v.rate).min()
            }
            "高清" => {
                if let Some(item) = variants.iter().find(|v| v.rate == 4) {
                    return Some(item.rate);
                }
                if let Some(rate) = find_by_keywords(&["蓝光", "蓝光4M"], false) {
                    return Some(rate);
                }
                if let Some(rate) = find_by_keywords(&["超清"], true) {
                    return Some(rate);
                }
                if let Some(rate) = find_by_keywords(&["高清"], true) {
                    return Some(rate);
                }
                variants
                    .iter()
                    .filter(|v| v.rate != 0)
                    .max_by_key(|v| v.bit.unwrap_or(0))
                    .map(|v| v.rate)
                    .or_else(|| {
                        variants
                            .iter()
                            .filter(|v| v.rate != 0)
                            .max_by_key(|v| v.rate)
                            .map(|v| v.rate)
                    })
            }
            "标清" => {
                if let Some(item) = variants.iter().find(|v| v.rate == 3) {
                    return Some(item.rate);
                }
                if let Some(rate) = find_by_keywords(&["超清"], true) {
                    return Some(rate);
                }
                if let Some(rate) = find_by_keywords(&["流畅"], true) {
                    return Some(rate);
                }
                if let Some(rate) = find_by_keywords(&["标清"], true) {
                    return Some(rate);
                }
                if let Some(rate) = find_by_keywords(&["普清"], true) {
                    return Some(rate);
                }
                variants
                    .iter()
                    .filter(|v| v.rate != 0)
                    .min_by_key(|v| v.bit.unwrap_or(i32::MAX))
                    .map(|v| v.rate)
                    .or_else(|| {
                        variants
                            .iter()
                            .filter(|v| v.rate != 0)
                            .min_by_key(|v| v.rate)
                            .map(|v| v.rate)
                    })
            }
            _ => {
                if let Some(rate) = find_by_keywords(&[canonical], false) {
                    return Some(rate);
                }
                None
            }
        }
    }
}

/// 整理接口返回的 CDN 列表：去掉空值与重复项，保持接口原有顺序，
/// 只把 scdn 系列排到最后作为备用线路。
fn order_cdns(cdns: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut ordered: Vec<_> = cdns
        .into_iter()
        .filter(|cdn| !cdn.trim().is_empty() && seen.insert(cdn.clone()))
        .collect();
    ordered.sort_by_key(|cdn| cdn.starts_with("scdn"));
    ordered
}

/// 生成本次取流的线路尝试顺序：手动首选排最前，自动恢复按索引轮换。
fn cdn_candidates(
    requested: Option<&str>,
    available: &[String],
    candidate_index: Option<usize>,
) -> Vec<String> {
    let mut candidates = order_cdns(available.to_vec());
    if let Some(target) = requested.map(str::trim).filter(|cdn| !cdn.is_empty()) {
        if let Some(index) = candidates
            .iter()
            .position(|cdn| cdn.eq_ignore_ascii_case(target))
        {
            let preferred = candidates.remove(index);
            candidates.insert(0, preferred);
        }
    }
    if candidates.is_empty() {
        candidates.push(normalize_douyu_cdn(requested).to_string());
    }
    // 自动恢复按实际 API 候选轮换，索引 0 保留手动首选。
    let offset = candidate_index.unwrap_or(0) % candidates.len();
    candidates.rotate_left(offset);
    candidates
}

/// 依次尝试候选线路，返回第一条成功的地址；全部失败时汇总各自的错误。
async fn first_playable_url<F, Fut>(
    cdns: &[String],
    mut fetch: F,
) -> Result<String, Box<dyn std::error::Error>>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, Box<dyn std::error::Error>>>,
{
    let mut errors = Vec::new();
    for cdn in cdns {
        match fetch(cdn.clone()).await {
            Ok(url) => return Ok(url),
            Err(error) => errors.push(format!("{}：{}", cdn, error)),
        }
    }
    Err(format!("斗鱼所有线路取流失败：{}", errors.join("；")).into())
}

/// 拼装播放地址，并校验结果确实是可用的 http/https 绝对地址。
fn compose_douyu_url(data: &Value) -> Result<String, Box<dyn std::error::Error>> {
    let host = data
        .get("rtmp_url")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("斗鱼播放响应缺少有效主机")?;
    let stream = data
        .get("rtmp_live")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("斗鱼播放响应缺少有效流地址")?;
    let composed = format!("{}/{}", host, decode_html_entities(stream));
    let parsed = url::Url::parse(&composed)?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("斗鱼播放响应包含非法地址".into());
    }
    Ok(composed)
}

pub async fn get_stream_url(
    room_id: &str,
    cdn: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let douyu = DouYu::new(room_id).await?;
    let url = douyu.get_real_url(cdn).await?;
    Ok(url)
}

pub async fn get_stream_url_with_quality(
    room_id: &str,
    quality: &str,
    cdn: Option<&str>,
    candidate_index: Option<usize>,
) -> Result<String, Box<dyn std::error::Error>> {
    let douyu = DouYu::new(room_id).await?;
    let url = douyu
        .get_real_url_with_quality(quality, cdn, candidate_index)
        .await?;
    Ok(url)
}

#[cfg(test)]
mod douyu_tests {
    use super::*;

    #[test]
    fn ordinary_cdns_keep_api_order_and_scdn_is_backup() {
        let cdns = ["scdn1", "ws-h5", "ali-h5", "ws-h5", "scdn2"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(order_cdns(cdns), vec!["ws-h5", "ali-h5", "scdn1", "scdn2"]);
    }

    #[test]
    fn preferred_cdn_is_first_then_remaining_api_order() {
        let cdns = vec!["ws-h5".into(), "ali-h5".into(), "scdn1".into()];
        assert_eq!(
            cdn_candidates(Some("ALI-H5"), &cdns, None),
            vec!["ali-h5", "ws-h5", "scdn1"]
        );
        assert_eq!(
            cdn_candidates(Some("scdn1"), &cdns, None),
            vec!["scdn1", "ws-h5", "ali-h5"]
        );
    }

    #[tokio::test]
    async fn failed_cdn_falls_back_without_requesting_later_successful_lines() {
        let cdns = vec!["失败".into(), "可用".into(), "备用".into()];
        let attempted = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = attempted.clone();
        let result = first_playable_url(&cdns, move |cdn| {
            record.lock().unwrap().push(cdn.clone());
            async move {
                if cdn == "失败" {
                    Err("线路错误".into())
                } else {
                    Ok("http://example.com/live.flv".into())
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), "http://example.com/live.flv");
        assert_eq!(*attempted.lock().unwrap(), vec!["失败", "可用"]);
    }

    #[tokio::test]
    async fn all_failed_cdns_report_errors() {
        let cdns = vec!["线路一".into(), "线路二".into()];
        let result = first_playable_url(&cdns, |cdn| async move {
            Err(format!("{}接口不可用", cdn).into())
        })
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("线路一接口不可用"));
        assert!(error.contains("线路二接口不可用"));
    }

    #[test]
    fn missing_cdns_keep_default_and_unknown_preference_uses_api_first() {
        assert_eq!(cdn_candidates(None, &[], None), vec!["ws-h5"]);
        assert_eq!(cdn_candidates(Some("tct-h5"), &[], None), vec!["tct-h5"]);
        assert_eq!(
            cdn_candidates(Some("未知"), &["ali-h5".into(), "ws-h5".into()], None),
            vec!["ali-h5", "ws-h5"]
        );
    }

    #[test]
    fn reconnect_rotates_real_api_cdns_including_scdn_backup() {
        let cdns = vec!["ws-h5".into(), "scdn1".into()];
        assert_eq!(
            cdn_candidates(Some("ws-h5"), &cdns, Some(0)),
            vec!["ws-h5", "scdn1"]
        );
        assert_eq!(
            cdn_candidates(Some("ws-h5"), &cdns, Some(1)),
            vec!["scdn1", "ws-h5"]
        );
        assert_eq!(
            cdn_candidates(Some("ws-h5"), &cdns, Some(2)),
            vec!["ws-h5", "scdn1"]
        );
        assert_eq!(
            cdn_candidates(Some("scdn1"), &cdns, None),
            vec!["scdn1", "ws-h5"]
        );
        assert_eq!(
            cdn_candidates(Some("scdn1"), &cdns, Some(1)),
            vec!["ws-h5", "scdn1"]
        );
        assert_eq!(cdn_candidates(None, &[], Some(9)), vec!["ws-h5"]);
    }

    #[test]
    fn malformed_play_urls_are_errors_and_http_is_preserved() {
        for data in [
            serde_json::json!(null),
            serde_json::json!({}),
            serde_json::json!({"rtmp_url": "null", "rtmp_live": "null"}),
            serde_json::json!({"rtmp_url": "https://example.com", "rtmp_live": ""}),
        ] {
            assert!(compose_douyu_url(&data).is_err());
        }
        let data = serde_json::json!({"rtmp_url": "http://example.com", "rtmp_live": "live.flv?a=1&amp;b=2"});
        assert_eq!(
            compose_douyu_url(&data).unwrap(),
            "http://example.com/live.flv?a=1&b=2"
        );
    }
}
