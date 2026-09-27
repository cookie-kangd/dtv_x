// Twitch 平台 API（参考 dtv_mx 的 TwitchApiAndroid 实现）。
//
// 链路：
// - 分类/分类内列表：GQL ad-hoc 查询（https://gql.twitch.tv/gql），匿名 + Client-ID + X-Device-Id
// - 「推荐」列表：DirectoryPage_Game persisted query + broadcasterLanguages=ZH（中文热门，
//   对齐网页版中文用户的推荐内容；ad-hoc streams(languages:) 会被服务端静默忽略）
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

// 目录页 persisted query（网页版「浏览」页同款，支持 broadcasterLanguages 语言过滤；
// ad-hoc 的 streams(languages:) 会被服务端静默忽略，只有这个 persisted 查询真正生效）
const DIRECTORY_GAME_HASH: &str =
    "86bcceb4e8b1a51256ff8eed8bd8aae4acacf80d737efe904f84f3aeadf8cafd";
// 「推荐」分区用中文热门目录（谈天说地 = Just Chatting，中文主播聚集地，
// 与网页版中文用户看到的推荐内容一致）。注意：游标翻页会触发 Twitch 反爬
// integrity check，因此中文推荐只取单页（40 条），不跟随游标。
const ZH_DIRECTORY_SLUG: &str = "just-chatting";

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

// 目录页 persisted query（POST 一次，容忍响应里的 per-field error——
// 该 persisted 文档的 profileImageURL 字段在服务端会报错但数据仍完整返回）
async fn gql_persisted_directory(
    slug: &str,
    limit: i64,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "operationName": "DirectoryPage_Game",
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": DIRECTORY_GAME_HASH } },
        "variables": {
            "limit": limit,
            "slug": slug,
            "imageWidth": 320,
            "includeCostreaming": false,
            "options": {
                "broadcasterLanguages": ["ZH"],
                "freeformTags": null,
                "includeRestricted": ["SUB_ONLY_LIVE"],
                "recommendationsContext": { "platform": "web" },
                "sort": "VIEWER_COUNT",
                "systemFilters": [],
                "tags": [],
                "requestID": "JIRA-VXP-2397",
            },
            "sortTypeIsRecency": false,
        }
    });
    let resp = http_client()
        .post(GQL_URL)
        .header("Client-ID", CLIENT_ID)
        .header("X-Device-Id", device_id().as_str())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Twitch 目录请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Twitch 目录 HTTP {}", status));
    }
    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Twitch 目录响应解析失败: {}", e))?;
    if root["data"].is_null() {
        return Err(format!(
            "Twitch 目录返回错误: {}",
            root["errors"].to_string().chars().take(200).collect::<String>()
        ));
    }
    Ok(root["data"].clone())
}

// 批量补头像：users(logins:) ad-hoc 查询（中文目录 persisted 响应里 avatar 字段会报错为空）
async fn fetch_user_avatars(logins: &[String]) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if logins.is_empty() {
        return out;
    }
    let body = serde_json::json!({
        "query": "query($logins:[String!]){users(logins:$logins){login profileImageURL(width:70)}}",
        "variables": { "logins": logins }
    });
    let resp = http_client()
        .post(GQL_URL)
        .header("Client-ID", CLIENT_ID)
        .header("X-Device-Id", device_id().as_str())
        .json(&body)
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(_) => return out,
    };
    let root: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return out,
    };
    if let Some(users) = root["data"]["users"].as_array() {
        for u in users {
            if let (Some(login), Some(url)) = (json_str(u, "login"), json_str(u, "profileImageURL")) {
                out.insert(login.to_string(), url.to_string());
            }
        }
    }
    out
}

fn node_to_item(node: &serde_json::Value) -> Option<TwitchStreamerFrontend> {
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
    Some(TwitchStreamerFrontend {
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
    })
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

    let data = gql(GAMES_QUERY, serde_json::json!({ "first": 100 })).await?;
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

const GAME_STREAMS_QUERY: &str = r#"
query($slug:String!,$first:Int,$cursor:Cursor){
  game(slug:$slug){
    id displayName
    streams(first:$first,after:$cursor){
      edges{ cursor node{ id title viewersCount previewImageURL(width:320,height:180)
        game{ displayName slug }
        broadcaster{ login displayName profileImageURL(width:70) } } }
      pageInfo{ hasNextPage }
    }
  }
}
"#;

fn parse_streams(data: &serde_json::Value) -> (Vec<TwitchStreamerFrontend>, Option<String>, bool) {
    let conn = if !data["streams"].is_null() {
        &data["streams"]
    } else if !data["game"]["streams"].is_null() {
        &data["game"]["streams"]
    } else {
        return (Vec::new(), None, false);
    };
    let mut items = Vec::new();
    let mut cursor: Option<String> = None;
    if let Some(edges) = conn["edges"].as_array() {
        for e in edges {
            if let Some(c) = json_str(e, "cursor") {
                cursor = Some(c.to_string());
            }
            if let Some(item) = node_to_item(&e["node"]) {
                items.push(item);
            }
        }
    }
    let has_more = conn["pageInfo"]["hasNextPage"].as_str() == Some("true") && !items.is_empty();
    (items, cursor, has_more)
}

#[tauri::command]
pub async fn fetch_twitch_live_list(
    slug: Option<String>,
    cursor: Option<String>,
) -> Result<TwitchLiveListResponse, String> {
    let slug_clean = slug.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // 「推荐」分区：改用中文热门目录（谈天说地 + ZH 过滤），
    // 对齐网页版中文用户看到的推荐内容（原全局热门几乎全是英文频道）。
    // 游标翻页会触发 Twitch 反爬 integrity check，故只取单页、不再加载更多。
    if slug_clean.is_none() {
        return fetch_zh_recommend_list().await;
    }

    let query = GAME_STREAMS_QUERY;
    let mut variables = serde_json::json!({ "first": 30 });
    if let Some(s) = &slug_clean {
        variables["slug"] = serde_json::json!(s);
    }
    if let Some(c) = &cursor {
        variables["cursor"] = serde_json::json!(c);
    }
    match gql(query, variables).await {
        Ok(data) => {
            let (items, next_cursor, has_more) = parse_streams(&data);
            Ok(TwitchLiveListResponse {
                error: 0,
                msg: None,
                data: Some(items),
                cursor: next_cursor,
                has_more,
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

// 中文推荐单页：DirectoryPage_Game(just-chatting, ZH) + users 批量补头像
async fn fetch_zh_recommend_list() -> Result<TwitchLiveListResponse, String> {
    match gql_persisted_directory(ZH_DIRECTORY_SLUG, 40).await {
        Ok(data) => {
            let (items, _cursor, _has_more) = parse_streams(&data);
            let mut items = items;
            let logins: Vec<String> = items.iter().map(|i| i.room_id.clone()).collect();
            let avatars = fetch_user_avatars(&logins).await;
            for it in items.iter_mut() {
                if let Some(a) = avatars.get(&it.room_id) {
                    if !a.is_empty() {
                        it.avatar = a.clone();
                    }
                }
            }
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
    // supported_codecs=h264：强制只下发 H.264 变体（WebView2 对 HEVC/AV1 支持不稳定）；
    // device_id / play_session_id 与网页版播放器行为对齐，减少边缘节点 502/风控概率
    Ok(format!(
        "{}{}.m3u8?token={}&sig={}&allow_source=true&allow_audio_only=true&platform=web&player=site&supported_codecs=h264&device_id={}&play_session_id={}",
        USHER_URL,
        login,
        urlencoding::encode(&token),
        sig,
        device_id().as_str(),
        play_session_id().as_str()
    ))
}

// 进程内稳定的播放会话串（usher play_session_id，网页版每次播放随机生成）
fn play_session_id() -> &'static String {
    static PLAY_SESSION: OnceLock<String> = OnceLock::new();
    PLAY_SESSION.get_or_init(|| {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..32).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
    })
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
