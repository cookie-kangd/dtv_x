// Twitch 平台 API（对齐 dtv_mx 的 TwitchApiAndroid 实现，参数以 dtv_mx 为准）。
//
// 链路：
// - 分类/列表：GQL ad-hoc 查询（https://gql.twitch.tv/gql），匿名 + Client-ID + X-Device-Id
// - 语言过滤：语言必须塞进 options 对象（streams(options:{languages:[ZH])）才生效；
//   平铺参数 streams(languages:) 会被服务端静默忽略
// - 「推荐」：中文人气总榜 + 中文谈天说地 + 中文IRL 三路聚合去重、按人气重排（dtv_mx 同款）
// - 翻页：匿名 Client-ID 带 after 游标会被 integrity check 拒绝，全部按「单页 30 条」处理
// - 播放：PlaybackAccessToken（persisted query）→ usher master m3u8 → 解析画质变体
// 注意：Twitch 在国内无法直连，reqwest 默认遵循系统代理环境变量（与 WebView2 行为一致），
// 因此这里**不要**像国内平台那样 no_proxy()。
use serde::Serialize;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const GQL_URL: &str = "https://gql.twitch.tv/gql";
const CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const USHER_URL: &str = "https://usher.ttvnw.net/api/channel/hls/";
const REFERER: &str = "https://www.twitch.tv/";

// PlaybackAccessToken 的官方 persisted query（与 dtv_mx 一致）
const PLAYBACK_ACCESS_TOKEN_HASH: &str =
    "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712";

// GQL 本地化语言：让分类名与网页版中文界面一致（Just Chatting → 谈天说地）
const ACCEPT_LANGUAGE: &str = "zh-CN";

// 语言过滤 options：只看中文（Language 枚举里中文只有 ZH）
fn zh_only_options() -> serde_json::Value {
    serde_json::json!({ "languages": ["ZH"] })
}
// 不加任何过滤（全语言），比传 null 更省得踩「可空输入类型」的坑
fn no_options() -> serde_json::Value {
    serde_json::json!({})
}

// 「推荐」聚合用的补充分类：中文观众最聚集的板块（谈天说地 = Just Chatting、IRL）
const RECOMMEND_EXTRA_SLUGS: [&str; 2] = ["just-chatting", "irl"];

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            )
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("failed to build twitch http client")
    })
}

// 匿名 GQL 完整性头：一个稳定的随机设备串，进程内保持不变
fn device_id() -> &'static String {
    static DEVICE_ID: OnceLock<String> = OnceLock::new();
    DEVICE_ID.get_or_init(|| {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..32).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
    })
}

async fn gql(query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "query": query, "variables": variables });
    let resp = http_client()
        .post(GQL_URL)
        .header("Client-ID", CLIENT_ID)
        .header("X-Device-Id", device_id().as_str())
        // Twitch GQL 按 Accept-Language 返回本地化文案：带上中文后分类名
        // 变成网页版那套中文（Just Chatting → 谈天说地），与 dtv_mx 一致
        .header("Accept-Language", ACCEPT_LANGUAGE)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Twitch GQL 请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Twitch GQL HTTP {}", status));
    }
    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Twitch GQL 响应解析失败: {}", e))?;
    if root.get("errors").is_some() {
        return Err(format!(
            "Twitch GQL 返回错误: {}",
            root["errors"].to_string().chars().take(200).collect::<String>()
        ));
    }
    Ok(root["data"].clone())
}

fn json_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn node_to_item(node: &serde_json::Value, zh_only: bool) -> Option<(TwitchStreamerFrontend, i64)> {
    let broadcaster = node.get("broadcaster")?;
    let login = json_str(broadcaster, "login")?.trim().to_string();
    if login.is_empty() {
        return None;
    }
    let display = json_str(broadcaster, "displayName")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&login)
        .to_string();
    let title = json_str(node, "title").map(|s| s.trim()).unwrap_or("").to_string();
    let game_name = node.get("game").and_then(|g| json_str(g, "displayName")).unwrap_or("");
    let viewers = json_str(node, "viewersCount")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    // 服务端按 options.languages 过滤偶有漏网（中文板块里会混进个别 EN），
    // 客户端按 node.language 再兜一层，保证「只看中文」时列表干净（dtv_mx 同款）
    if zh_only && json_str(node, "language").unwrap_or("") != "ZH" {
        return None;
    }
    let item = TwitchStreamerFrontend {
        room_id: login,
        nickname: display,
        title: if title.is_empty() {
            if !game_name.is_empty() {
                format!("正在直播 {}", game_name)
            } else {
                "直播中".to_string()
            }
        } else {
            title
        },
        avatar: json_str(broadcaster, "profileImageURL").unwrap_or("").to_string(),
        room_cover: json_str(node, "previewImageURL").unwrap_or("").to_string(),
        viewer_count_str: format_viewer_count(viewers),
        platform: "twitch".to_string(),
    };
    Some((item, viewers))
}

// 与虎牙 live_list.rs 相同的“万”格式化习惯
fn format_viewer_count(n: i64) -> String {
    if n >= 10_000 {
        let wan = n as f64 / 10_000.0;
        if wan >= 100.0 {
            format!("{:.0}万", wan)
        } else {
            format!("{:.1}万", wan)
        }
    } else {
        n.to_string()
    }
}

// ===== 分类 =====

#[derive(Serialize, Clone)]
pub struct TwitchCategory {
    pub slug: String,
    pub name: String,
}

static CATEGORIES_CACHE: OnceLock<std::sync::Mutex<Option<(Instant, Vec<TwitchCategory>)>>> =
    OnceLock::new();

const GAMES_QUERY: &str = r#"
query($first:Int){
  games(first:$first){ edges{ node{ slug displayName } } }
}
"#;

#[tauri::command]
pub async fn fetch_twitch_categories() -> Result<Vec<TwitchCategory>, String> {
    // 内存缓存 30 分钟：分类列表变化极慢，避免每次进页面都打 GQL
    let cache = CATEGORIES_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Some((at, list)) = cache.lock().unwrap().clone() {
        if at.elapsed() < Duration::from_secs(30 * 60) && !list.is_empty() {
            return Ok(list);
        }
    }

    let data = gql(GAMES_QUERY, serde_json::json!({ "first": 40 })).await?;
    let mut out: Vec<TwitchCategory> = Vec::new();
    if let Some(edges) = data["games"]["edges"].as_array() {
        for e in edges {
            let node = &e["node"];
            let slug = json_str(node, "slug").unwrap_or("").trim().to_string();
            let name = json_str(node, "displayName").unwrap_or("").trim().to_string();
            if !slug.is_empty() && !name.is_empty() {
                out.push(TwitchCategory { slug, name });
            }
        }
    }
    *cache.lock().unwrap() = Some((Instant::now(), out.clone()));
    Ok(out)
}

// ===== 直播列表 =====

#[derive(Serialize, Clone)]
pub struct TwitchStreamerFrontend {
    pub room_id: String,
    pub nickname: String,
    pub title: String,
    pub avatar: String,
    pub room_cover: String,
    pub viewer_count_str: String,
    pub platform: String,
}

#[derive(Serialize)]
pub struct TwitchLiveListResponse {
    pub error: i32,
    pub msg: Option<String>,
    pub data: Option<Vec<TwitchStreamerFrontend>>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

// ⚠️ 对齐 dtv_mx：匿名 Client-ID 带 after 游标翻页会被服务端
// "failed integrity check" 直接拒绝（IntegrityCheckFailed），第二页永远拿不到；
// 且 first 上限被限制在 30（>30 报 "argument 'first' value must be between 1 and 30"）。
// 因此 Twitch 列表一律按「单页 30 条」处理，语言过滤走 options 对象。
const STREAMS_QUERY: &str = r#"
query($first:Int,$options:StreamOptions){
  streams(first:$first,options:$options){
    edges{ node{ id title language viewersCount previewImageURL(width:320,height:180)
      game{ displayName slug }
      broadcaster{ login displayName profileImageURL(width:70) } } }
  }
}
"#;

const GAME_STREAMS_QUERY: &str = r#"
query($slug:String!,$first:Int,$options:GameStreamOptions){
  game(slug:$slug){
    id displayName
    streams(first:$first,options:$options){
      edges{ node{ id title language viewersCount previewImageURL(width:320,height:180)
        game{ displayName slug }
        broadcaster{ login displayName profileImageURL(width:70) } } }
    }
  }
}
"#;

fn parse_streams(data: &serde_json::Value, zh_only: bool) -> Vec<(TwitchStreamerFrontend, i64)> {
    let conn = if !data["streams"].is_null() {
        &data["streams"]
    } else if !data["game"]["streams"].is_null() {
        &data["game"]["streams"]
    } else {
        return Vec::new();
    };
    let mut items = Vec::new();
    if let Some(edges) = conn["edges"].as_array() {
        for e in edges {
            if let Some(pair) = node_to_item(&e["node"], zh_only) {
                items.push(pair);
            }
        }
    }
    items
}

#[tauri::command]
pub async fn fetch_twitch_live_list(
    slug: Option<String>,
    cursor: Option<String>,
) -> Result<TwitchLiveListResponse, String> {
    // cursor 参数仅为兼容前端签名而保留：匿名 Client-ID 带游标翻页会被
    // integrity check 拒绝（dtv_mx 踩坑记录），因此这里刻意不使用
    let _ = cursor;
    let slug_clean = slug.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // 「推荐」分区：中文三路聚合（dtv_mx 同款），内容对齐网页版中文推荐
    if slug_clean.is_none() {
        return fetch_zh_recommend_list().await;
    }

    // 分类内列表：默认不做语言过滤——用户点进具体游戏想看的是这个游戏
    // 最好看的内容，强行只留中文经常出现空列表；网页版分类页默认也是全语言
    let variables = serde_json::json!({
        "slug": slug_clean.unwrap_or_default(),
        "first": 30,
        "options": no_options()
    });
    match gql(GAME_STREAMS_QUERY, variables).await {
        Ok(data) => {
            let items = parse_streams(&data, false)
                .into_iter()
                .map(|(item, _)| item)
                .collect();
            Ok(TwitchLiveListResponse {
                error: 0,
                msg: None,
                data: Some(items),
                cursor: None,
                has_more: false,
            })
        }
        Err(e) => Ok(TwitchLiveListResponse {
            error: 1,
            msg: Some(e),
            data: None,
            cursor: None,
            has_more: false,
        }),
    }
}

// 中文推荐单页聚合（对齐 dtv_mx 的 fetchRecommendedStreams）：
// 中文人气总榜 + 中文谈天说地 + 中文IRL 三路并发，去重、按观众数重排。
// 单路只有 30 条且内容单薄，三路合并后带上中文观众最常看的谈天说地/IRL。
async fn fetch_zh_recommend_list() -> Result<TwitchLiveListResponse, String> {
    let top = async {
        let vars = serde_json::json!({ "first": 30, "options": zh_only_options() });
        gql(STREAMS_QUERY, vars)
            .await
            .map(|d| parse_streams(&d, true))
            .unwrap_or_default()
    };
    let [jc, irl] = RECOMMEND_EXTRA_SLUGS.map(|slug| async move {
        let vars = serde_json::json!({ "slug": slug, "first": 30, "options": zh_only_options() });
        gql(GAME_STREAMS_QUERY, vars)
            .await
            .map(|d| parse_streams(&d, true))
            .unwrap_or_default()
    });

    let (top_res, jc_res, irl_res) = tokio::join!(top, jc, irl);

    let mut merged: Vec<(TwitchStreamerFrontend, i64)> = Vec::new();
    merged.extend(top_res);
    merged.extend(jc_res);
    merged.extend(irl_res);

    let mut seen = std::collections::HashSet::new();
    merged.retain(|(item, _)| seen.insert(item.room_id.clone()));
    merged.sort_by(|a, b| b.1.cmp(&a.1));

    let items: Vec<TwitchStreamerFrontend> = merged.into_iter().map(|(item, _)| item).collect();
    Ok(TwitchLiveListResponse {
        error: 0,
        msg: None,
        data: Some(items),
        cursor: None,
        has_more: false,
    })
}

// ===== 播放 =====

#[derive(Serialize)]
pub struct TwitchStreamVariant {
    pub name: String,    // usher 画质代号（chunked / 720p60 / audio_only ...）
    pub display: String, // 展示名（原画 / 720P60 / 仅音频）
    pub url: String,
}

#[derive(Serialize)]
pub struct TwitchStreamInfo {
    pub stream_url: String,
    pub stream_type: String, // 固定 "hls"
    pub qualities: Vec<String>,
    pub selected_url: String,
    pub title: String,
    pub anchor_name: String,
    pub avatar: String,
    pub is_live: bool,
}

const USER_SNAPSHOT_QUERY: &str = r#"
query($l:String!){
  user(login:$l){
    login displayName profileImageURL(width:150)
    stream{ id title viewersCount previewImageURL(width:320,height:180) game{ displayName } }
  }
}
"#;

async fn fetch_user_snapshot(login: &str) -> Result<serde_json::Value, String> {
    let data = gql(USER_SNAPSHOT_QUERY, serde_json::json!({ "l": login })).await?;
    if data["user"].is_null() {
        return Err("房间不存在".to_string());
    }
    Ok(data["user"].clone())
}

/// 匿名拿 playback token（usher 凭据），返回 (token, sig)
async fn fetch_playback_token(login: &str) -> Result<(String, String), String> {
    let body = format!(
        r#"{{"operationName":"PlaybackAccessToken","extensions":{{"persistedQuery":{{"version":1,"sha256Hash":"{}"}}}},"variables":{{"isLive":true,"login":"{}","isVod":false,"vodID":"","playerType":"site","platform":"web"}}}}"#,
        PLAYBACK_ACCESS_TOKEN_HASH, login
    );
    let resp = http_client()
        .post(GQL_URL)
        .header("Client-ID", CLIENT_ID)
        .header("X-Device-Id", device_id().as_str())
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Twitch 播放凭据请求失败: {}", e))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Twitch 播放凭据解析失败: {}", e))?;
    let sa = root
        .get("data")
        .and_then(|d| d.get("streamPlaybackAccessToken"))
        .ok_or_else(|| "未获取到 Twitch 播放凭据".to_string())?;
    let token = json_str(sa, "value").ok_or("Twitch 播放凭据缺失")?.to_string();
    let sig = json_str(sa, "signature").ok_or("Twitch 播放凭据缺失")?.to_string();
    Ok((token, sig))
}

fn variant_display_name(raw: &str) -> String {
    match raw.to_lowercase().as_str() {
        "chunked" => "原画".to_string(),
        "audio_only" => "仅音频".to_string(),
        _ => raw.to_uppercase(),
    }
}

fn parse_master_playlist(text: &str) -> Vec<TwitchStreamVariant> {
    let mut out: Vec<TwitchStreamVariant> = Vec::new();
    let mut pending_video: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXT-X-STREAM-INF") {
            pending_video = extract_attr(line, "VIDEO");
        } else if !line.starts_with('#') {
            if let Some(video) = pending_video.take() {
                out.push(TwitchStreamVariant {
                    display: variant_display_name(&video),
                    name: video,
                    url: line.to_string(),
                });
            }
        }
    }
    // 原画排前、仅音频垫底，其余按分辨率高度降序
    fn sort_key(v: &TwitchStreamVariant) -> u32 {
        match v.name.to_lowercase().as_str() {
            "chunked" => 0,
            "audio_only" => 99,
            other => {
                // 720p60 / 1080p60 等：取高度
                let height = other
                    .split('p')
                    .next()
                    .and_then(|h| h.parse::<u32>().ok())
                    .unwrap_or(0);
                1000u32.saturating_sub(height).clamp(1, 98)
            }
        }
    }
    out.sort_by_key(sort_key);
    out.dedup_by(|a, b| a.name == b.name);
    out
}

fn extract_attr(line: &str, key: &str) -> Option<String> {
    // #EXT-X-STREAM-INF:...,VIDEO="chunked",...
    let needle = format!("{}=\"", key);
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

async fn build_usher_url(login: &str) -> Result<String, String> {
    let (token, sig) = fetch_playback_token(login).await?;
    // 参数与 dtv_mx 完全一致（网页版同款六参数），不额外自创参数
    Ok(format!(
        "{}{}.m3u8?token={}&sig={}&allow_source=true&allow_audio_only=true&platform=web&player=site",
        USHER_URL,
        login,
        urlencoding::encode(&token),
        sig
    ))
}

/// 拉取 usher master m3u8，返回 (master_url, 画质变体列表)。
/// usher 边缘节点偶发 502，重试一次。
async fn fetch_usher_playlist(login: &str) -> Result<(String, Vec<TwitchStreamVariant>), String> {
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let usher_url = build_usher_url(login).await?;
        match http_client()
            .get(&usher_url)
            .header("Referer", REFERER)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if status.is_success() {
                    let variants = parse_master_playlist(&text);
                    if variants.is_empty() {
                        return Err("该频道未返回可用画质".to_string());
                    }
                    return Ok((usher_url, variants));
                }
                last_err = format!("获取 Twitch 画质列表 HTTP {}", status);
            }
            Err(e) => {
                last_err = format!("获取 Twitch 画质列表失败: {}", e);
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn get_twitch_stream_cmd(
    login: String,
    quality: Option<String>,
) -> Result<TwitchStreamInfo, String> {
    let login_clean = login.trim().to_lowercase();
    if login_clean.is_empty() {
        return Err("频道名为空".to_string());
    }

    // 元数据与播放凭据/画质列表并发请求
    let (user_res, playlist_res) = tokio::join!(
        fetch_user_snapshot(&login_clean),
        fetch_usher_playlist(&login_clean)
    );

    let user = user_res?;
    if user["stream"].is_null() {
        return Err("主播未开播".to_string());
    }
    let (master_url, variants) = playlist_res?;

    let title = json_str(&user, "title").unwrap_or("").trim().to_string();
    let anchor_name = json_str(&user, "displayName")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&login_clean)
        .to_string();
    let avatar = json_str(&user, "profileImageURL").unwrap_or("").to_string();

    let qualities: Vec<String> = variants.iter().map(|v| v.display.clone()).collect();
    let quality_wanted = quality
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    // 按展示名匹配画质（忽略大小写）；未指定或匹配不到时回落原画（首个）
    let selected = quality_wanted
        .and_then(|q| variants.iter().find(|v| v.display.eq_ignore_ascii_case(q)))
        .or_else(|| variants.first());

    Ok(TwitchStreamInfo {
        stream_url: master_url,
        stream_type: "hls".to_string(),
        qualities,
        selected_url: selected.map(|v| v.url.clone()).unwrap_or_default(),
        title,
        anchor_name,
        avatar,
        is_live: true,
    })
}
