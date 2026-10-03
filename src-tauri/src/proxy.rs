use actix_web::{dev::ServerHandle, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use futures_util::TryStreamExt;
use reqwest::Client;
use url::Url;
// awc removed for now due to API differences; using reqwest streaming
use crate::StreamUrlStore;
use serde::Deserialize;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, State};

/// 本进程已启动的静态图片代理 base URL（如 `http://127.0.0.1:34721`）。
///
/// 存在的意义：静态代理的幂等判断**必须**基于「本进程是否启动过它」，
/// 而不能靠「该端口能否连上」—— 后者会把任意占用该端口的其它进程误认成我们的代理，
/// 让前端把错误 base 永久缓存、全站图片永久失效且无法自愈。
static STATIC_PROXY_BASE: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

fn static_proxy_base_cell() -> &'static StdMutex<Option<String>> {
    STATIC_PROXY_BASE.get_or_init(|| StdMutex::new(None))
}

// Define a struct to hold the server handle in a Tauri managed state
#[derive(Default)]
pub struct ProxyServerHandle(pub StdMutex<Option<ServerHandle>>);

// Align with pure_live-master's Huya playback UA
const HUYA_HYSDK_UA: &str =
    "HYSDK(Windows,30000002)_APP(pc_exe&7080000&official)_SDK(trans&2.34.0.5795)";

async fn find_free_port() -> u16 {
    // ★ 改为「让系统分配」：传 0 让操作系统挑一个当前空闲端口。
    //   原来这里硬返回 34719，但名字叫 find_free_port 却从不检测占用 ——
    //   一旦该端口被上次实例的残留 socket 或别的程序占住，bind 直接失败，
    //   start_proxy 报Err → 前端归类为「取流失败」→ 重连 6 次后彻底放弃，
    //   用户完全无法播放，而且没有任何补救路径。
    //   现在由 bind 后从 server.addrs() 取回真实端口，天然免疫端口冲突。
    0
}

#[derive(Deserialize)]
struct ImageQuery {
    url: String,
}

async fn image_proxy_handler(
    query: web::Query<ImageQuery>,
    client: web::Data<Client>,
) -> impl Responder {
    let url = query.url.clone();
    if url.is_empty() {
        return HttpResponse::BadRequest().body("Missing url query parameter");
    }

    let mut req = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5",
        );

    // Set a Referer to bypass hotlink protections
    if url.contains("hdslb.com") || url.contains("bilibili.com") {
        req = req
            .header("Referer", "https://live.bilibili.com/")
            .header("Origin", "https://live.bilibili.com");
    } else if url.contains("huya.com") {
        req = req
            .header("Referer", "https://www.huya.com/")
            .header("Origin", "https://www.huya.com");
    } else if url.contains("douyin") || url.contains("douyinpic.com") {
        req = req.header("Referer", "https://www.douyin.com/");
    }

    match req.send().await {
        Ok(upstream_response) => {
            let content_type = upstream_response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();

            // 为避免 Windows 下 chunked 传输的 Early-EOF，改为一次性读取 bytes 并返回
            if upstream_response.status().is_success() {
                match upstream_response.bytes().await {
                    Ok(bytes) => HttpResponse::Ok()
                        .content_type(content_type)
                        .insert_header(("Content-Length", bytes.len().to_string()))
                        // Allow the WebView to cache proxied images to avoid re-downloading covers/avatars
                        // when switching routes or scrolling lists.
                        .insert_header(("Cache-Control", "public, max-age=86400, immutable"))
                        .body(bytes),
                    Err(e) => {
                        eprintln!("[Rust/proxy.rs image] Failed to read bytes: {}", e);
                        HttpResponse::InternalServerError()
                            .body(format!("Failed to read image bytes: {}", e))
                    }
                }
            } else {
                let status_from_reqwest = upstream_response.status();
                let error_text = upstream_response
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("Failed to read error body from upstream: {}", e));
                eprintln!(
                    "[Rust/proxy.rs image] Upstream request to {} failed with status: {}. Body: {}",
                    url, status_from_reqwest, error_text
                );
                let actix_status_code =
                    actix_web::http::StatusCode::from_u16(status_from_reqwest.as_u16())
                        .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR);

                HttpResponse::build(actix_status_code).body(format!(
                    "Error fetching IMAGE from upstream (reqwest): {}. Status: {}. Details: {}",
                    url, status_from_reqwest, error_text
                ))
            }
        }
        Err(e) => {
            eprintln!(
                "[Rust/proxy.rs image] Failed to send request to upstream {}: {}",
                url, e
            );
            HttpResponse::InternalServerError()
                .body(format!("Error connecting to upstream IMAGE {}: {}", url, e))
        }
    }
}

// Your actual proxy logic - this is a simplified placeholder
async fn flv_proxy_handler(
    _req: HttpRequest,
    stream_url_store: web::Data<StreamUrlStore>,
    client: web::Data<Client>,
) -> impl Responder {
    let url = stream_url_store.url.lock().unwrap().clone();
    if url.is_empty() {
        return HttpResponse::NotFound().body("Stream URL is not set or empty.");
    }

    println!(
        "[Rust/proxy.rs handler] Incoming FLV proxy request -> {}",
        url
    );

    let mut req = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "video/x-flv,application/octet-stream,*/*")
        .header("Range", "bytes=0-")
        .header("Connection", "keep-alive");

    // 如果是虎牙域名，添加必要的 Referer/Origin 头
    if url.contains("huya.com") || url.contains("hy-cdn.com") || url.contains("huyaimg.com") {
        req = req
            .header("User-Agent", HUYA_HYSDK_UA)
            .header("Referer", "https://www.huya.com/")
            .header("Origin", "https://www.huya.com");
    }
    // 如果是B站域名，添加必要的 Referer 头
    if url.contains("bilivideo") || url.contains("bilibili.com") || url.contains("hdslb.com") {
        req = req.header("Referer", "https://live.bilibili.com/");
    }

    match req.send().await {
        Ok(upstream_response) => {
            if upstream_response.status().is_success() {
                let mut response_builder = HttpResponse::Ok();
                response_builder
                    .content_type("video/x-flv")
                    .insert_header(("Connection", "keep-alive"))
                    .insert_header(("Cache-Control", "no-store"))
                    .insert_header(("Accept-Ranges", "bytes"));

                let byte_stream = upstream_response.bytes_stream().map_err(|e| {
                    eprintln!(
                        "[Rust/proxy.rs handler] Error reading bytes from upstream: {}",
                        e
                    );
                    actix_web::error::ErrorInternalServerError(format!(
                        "Upstream stream error: {}",
                        e
                    ))
                });

                response_builder.streaming(byte_stream)
            } else {
                let status_from_reqwest = upstream_response.status(); // Renamed for clarity
                let error_text = upstream_response
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("Failed to read error body from upstream: {}", e));
                eprintln!(
                    "[Rust/proxy.rs handler] Upstream request to {} failed with status: {}. Body: {}",
                    url, status_from_reqwest, error_text
                );
                // Convert reqwest::StatusCode to actix_web::http::StatusCode
                let actix_status_code =
                    actix_web::http::StatusCode::from_u16(status_from_reqwest.as_u16())
                        .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR);

                HttpResponse::build(actix_status_code).body(format!(
                    "Error fetching FLV stream from upstream (reqwest): {}. Status: {}. Details: {}",
                    url, status_from_reqwest, error_text
                ))
            }
        }
        Err(e) => {
            eprintln!(
                "[Rust/proxy.rs handler] Failed to send request to upstream {} with reqwest: {}",
                url, e
            );
            HttpResponse::InternalServerError().body(format!(
                "Error connecting to upstream FLV stream {} with reqwest: {}",
                url, e
            ))
        }
    }
}

// ===================== HLS 代理（/hls?url=...） =====================
//
// 背景：Twitch 的 playlist 边缘节点（*.playlist.ttvnw.net）会校验 Origin 头，
// 只放行 https://www.twitch.tv；而 WebView2 里跨域 XHR 一定会带上
// Origin: http://tauri.localhost，且 Origin 属于 forbidden header（JS 无法改写），
// 于是 hls.js 请求 m3u8 一律 403 → 播放黑屏转圈（弹幕走独立 IRC 通道所以正常）。
//
// 解决：让 hls.js 只请求本地代理，由 Rust 侧（reqwest）去回源。Rust 发出的请求
// 不带 Origin，因此可正常取回 playlist / segment；m3u8 文本里的 URL 会被改写成
// 指向本代理的绝对地址，保证后续请求同样绕开浏览器。

/// 遵循系统代理的 HTTP 客户端（Twitch 等海外平台必须走系统代理，不能 no_proxy）
#[derive(Clone)]
pub struct SystemProxyHttpClient(pub Client);

#[derive(Deserialize)]
struct HlsQuery {
    url: String,
}

fn is_playlist(url: &str, content_type: &str) -> bool {
    let path = url.split('?').next().unwrap_or(url).to_lowercase();
    if path.ends_with(".m3u8") || path.ends_with(".m3u") {
        return true;
    }
    let ct = content_type.to_lowercase();
    ct.contains("mpegurl") || ct.contains("mpeg-url") || ct.contains("application/vnd.apple.mpeg")
}

fn absolutize(base: &Option<Url>, raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Some(raw.to_string());
    }
    base.as_ref()?.join(raw).ok().map(|u| u.to_string())
}

/// 把 m3u8 中出现的 URL（含 #EXT-X-KEY / #EXT-X-MAP 的 URI="..." 属性）
/// 全部改写成指向本代理的绝对 URL，避免 hls.js 用相对路径解析回原始域名。
fn rewrite_playlist(text: &str, base_url: &str, proxy_base: &str) -> String {
    let base = Url::parse(base_url).ok();
    let to_proxy = |absolute: &str| -> String {
        format!("{}/hls?url={}", proxy_base, urlencoding::encode(absolute))
    };

    let mut out = String::with_capacity(text.len() + 512);
    for raw_line in text.split('\n') {
        let line = raw_line.trim_end_matches('\r').trim();
        if line.is_empty() {
            out.push('\n');
            continue;
        }

        if line.starts_with('#') {
            // 标签行：只需处理内嵌的 URI="..."（如 #EXT-X-KEY / #EXT-X-MAP）
            let mut result = line.to_string();
            let mut cursor = 0usize;
            while let Some(rel) = result[cursor..].find("URI=\"") {
                let value_start = cursor + rel + 5;
                let remain = &result[value_start..];
                let value_end = match remain.find('"') {
                    Some(idx) => value_start + idx,
                    None => break,
                };
                let uri = result[value_start..value_end].to_string();
                match absolutize(&base, &uri) {
                    Some(absolute) => {
                        let replaced = to_proxy(&absolute);
                        result.replace_range(value_start..value_end, &replaced);
                        cursor = value_start + replaced.len() + 1;
                    }
                    None => cursor = value_end + 1,
                }
                if cursor > result.len() {
                    break;
                }
            }
            out.push_str(&result);
            out.push('\n');
            continue;
        }

        // URL 行
        match absolutize(&base, line) {
            Some(absolute) => out.push_str(&to_proxy(&absolute)),
            None => out.push_str(line),
        }
        out.push('\n');
    }
    out
}

async fn hls_proxy_handler(
    req: HttpRequest,
    query: web::Query<HlsQuery>,
    client: web::Data<SystemProxyHttpClient>,
) -> impl Responder {
    let url = query.url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return HttpResponse::BadRequest().body("invalid url");
    }
    let proxy_base = format!("http://{}", req.connection_info().host().to_string());

    let upstream = client
        .0
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Accept", "*/*")
        .send()
        .await;

    let resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Rust/proxy.rs hls] upstream error {}: {}", url, e);
            return HttpResponse::InternalServerError().body(format!("hls upstream error: {}", e));
        }
    };

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if !status.is_success() {
        let code = actix_web::http::StatusCode::from_u16(status.as_u16())
            .unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY);
        eprintln!("[Rust/proxy.rs hls] upstream {} -> {}", url, status);
        return HttpResponse::build(code).body(format!("upstream status {}", status));
    }

    match resp.bytes().await {
        Ok(bytes) => {
            if is_playlist(&url, &content_type) {
                let text = String::from_utf8_lossy(&bytes).to_string();
                let rewritten = rewrite_playlist(&text, &url, &proxy_base);
                HttpResponse::Ok()
                    .content_type(if content_type.is_empty() || content_type == "application/octet-stream" {
                        "application/vnd.apple.mpegurl"
                    } else {
                        content_type.as_str()
                    })
                    .insert_header(("Content-Length", rewritten.len().to_string()))
                    .insert_header(("Cache-Control", "no-store"))
                    .body(rewritten)
            } else {
                HttpResponse::Ok()
                    .content_type(content_type)
                    .insert_header(("Content-Length", bytes.len().to_string()))
                    .insert_header(("Cache-Control", "no-store"))
                    .body(bytes)
            }
        }
        Err(e) => {
            eprintln!("[Rust/proxy.rs hls] read body error {}: {}", url, e);
            HttpResponse::InternalServerError().body(format!("hls read error: {}", e))
        }
    }
}

#[tauri::command]
pub async fn start_proxy(
    _app_handle: AppHandle,
    server_handle_state: State<'_, ProxyServerHandle>,
    stream_url_store: State<'_, StreamUrlStore>,
) -> Result<String, String> {
    let port = find_free_port().await;
    let current_stream_url = stream_url_store.url.lock().unwrap().clone();

    if current_stream_url.is_empty() {
        return Err("Stream URL is not set in store. Cannot start proxy.".to_string());
    }

    // stream_url_data_for_actix can be created once and cloned, as StreamUrlStore is Arc based and Send + Sync
    let stream_url_data_for_actix = web::Data::new(stream_url_store.inner().clone());
    // REMOVED: let awc_client_for_actix = web::Data::new(Client::default());

    // Ensure MutexGuard is dropped before .await
    let existing_handle_to_stop = { server_handle_state.0.lock().unwrap().take() };
    if let Some(existing_handle) = existing_handle_to_stop {
        existing_handle.stop(false).await;
    }

    let server = match HttpServer::new(move || {
        let app_data_stream_url = stream_url_data_for_actix.clone();
        // Create reqwest::Client inside the closure for each worker thread (for images)
        let app_data_reqwest_client = web::Data::new(
            Client::builder()
                .no_proxy()
                .http1_only()
                .gzip(false)
                .brotli(false)
                .no_deflate()
                // 池空闲连接要设上限：设为None 会让空闲连接永久驻留，
                // 长期浏览时白白占用 socket 与内存。
                .pool_idle_timeout(Some(Duration::from_secs(30)))
                .pool_max_idle_per_host(4)
                .tcp_keepalive(Duration::from_secs(60))
                // ★ 这里是「图片」专用 client，绝不能设 7200s（2 小时）。
                //   图片代理与 FLV/HLS 转发共用同一个 actix HttpServer，
                //   而 actix 的 worker 数= CPU 核数，是**共享**的。
                //   列表滚动一次就能并发几十个 /image 请求，只要上游 CDN 挂住，
                //   每个请求会占住一个 worker 长达 2 小时 —— 几十个就足以耗尽 worker 池，
                //   /live.flv 与 /hls 跟着一起卡死，表现为「看直播突然整个画面冻住」。
                //   图片是小资源，20s 拿不到就是失败，重试成本远低于拖垮播放。
                .timeout(Duration::from_secs(20))
                .build()
                .expect("failed to build client"),
        );
        // 走系统代理的客户端（Twitch 等海外平台回源用）
        let app_data_system_client = web::Data::new(SystemProxyHttpClient(
            Client::builder()
                .http1_only()
                .pool_max_idle_per_host(8)
                .tcp_keepalive(Duration::from_secs(60))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("failed to build system proxy client"),
        ));
        App::new()
            .app_data(app_data_stream_url)
            .app_data(app_data_reqwest_client)
            .app_data(app_data_system_client)
            .wrap(actix_cors::Cors::permissive())
            .route("/live.flv", web::get().to(flv_proxy_handler))
            .route("/image", web::get().to(image_proxy_handler))
            .route("/hls", web::get().to(hls_proxy_handler))
    })
    .keep_alive(Duration::from_secs(120))
    .bind(("127.0.0.1", port))
    {
        Ok(srv) => srv,
        Err(e) => {
            let err_msg = format!(
                "[Rust/proxy.rs] Failed to bind server to port {}: {}",
                port, e
            );
            eprintln!("{}", err_msg);
            return Err(err_msg);
        }
    };

    // ★ 取回操作系统实际分配的端口。
    //   find_free_port 现在传 0 让系统挑端口，所以必须用 addrs() 读回真实值，
    //   否则 proxy_url 里会带着端口 0，前端拿到 http://127.0.0.1:0/live.flv 直接失效。
    //   注意：Server::addrs() 返回的已经是 std::net::SocketAddr，不需要（也没有）
    //   as_std() 方法。
    let bound_port: u16 = server
        .addrs()
        .into_iter()
        .next()
        .map(|addr| addr.port())
        .ok_or_else(|| {
            let msg = "[Rust/proxy.rs] 无法获取代理服务器实际绑定的端口".to_string();
            eprintln!("{}", msg);
            msg
        })?;

    // ★ 不需要（也不能）调 .run()：HttpServer::bind() 返回的已经是
    //   actix_web::dev::Server（已绑定、未启动），直接 handle()/await 即可。
    let server_handle_for_state = server.handle();
    *server_handle_state.0.lock().unwrap() = Some(server_handle_for_state);

    // Use tauri::async_runtime::spawn directly
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.await {
            eprintln!("[Rust/proxy.rs] Proxy server run error: {}", e);
        } else {
            println!("[Rust/proxy.rs] Proxy server on port {} shut down.", bound_port);
        }
    });

    let proxy_url = format!("http://127.0.0.1:{}/live.flv", bound_port);
    Ok(proxy_url)
}

#[tauri::command]
pub async fn start_static_proxy_server(
    _app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
) -> Result<String, String> {
    // Use a dedicated port range for static image proxy to avoid interfering with FLV stream proxy
    //
    // ★ 关键修复：原实现「端口能连上就认为代理已启动」，这是个危险的误判。
    //   34721 被**任何其它进程**占用（或本应用上次异常退出的残留 socket）时，
    //   这里会返回 http://127.0.0.1:34721，而前端 useImageProxy 会把这个
    //   错误的 base 永久缓存进模块级变量、此后 early return 永不重试——
    //   结果是全站封面/头像永久加载失败且无法自愈，只能重启应用。
    //   现在改成：按候选端口逐个尝试 bind，谁成功用谁；真正的幂等交给
    //   「本进程是否已启动」这个事实判断，而不是靠端口可连性猜测。
    const PORT_CANDIDATES: [u16; 8] = [34721, 34722, 34723, 34724, 34725, 34726, 34727, 34728];

    // 幂等：只有「本进程确实启动过静态代理」才直接复用。
    // 端口可连 ≠ 是我们启动的，所以这里必须查自己的记录。
    if let Some(existing) = static_proxy_base_cell().lock().unwrap().clone() {
        return Ok(existing);
    }

    // ★ 这里必须用 fn 而不是闭包：闭包捕获了 stream_url_data_for_actix 会被move 走，
    //   只能调用一次（FnOnce），无法在「候选端口循环」里复用（E0382）。
    //   改成普通函数，每次调用各拿一份 clone，互不影响。
    //
    // ★ 注意 HttpServer::bind() 的返回类型：actix-web 4 中它直接返回
    //   **actix_web::dev::Server**（已绑定、未启动），不是 HttpServer ——
    //   所以这里既不能写 `-> io::Result<HttpServer>`，也不能再调 `.run()`（E0599/E0308）。
    fn build_server(bound_port: u16, store: StreamUrlStore) -> std::io::Result<actix_web::dev::Server> {
        let stream_url_data_for_actix = web::Data::new(store);
        HttpServer::new(move || {
            let app_data_stream_url = stream_url_data_for_actix.clone();
            let app_data_reqwest_client = web::Data::new(
                Client::builder()
                    .no_proxy()
                    .http1_only()
                    .gzip(false)
                    .brotli(false)
                    .no_deflate()
                    // 池空闲连接要设上限：设为 None 会让空闲连接永久驻留，
                    // 长期浏览时白白占用 socket 与内存。
                    .pool_idle_timeout(Some(Duration::from_secs(30)))
                    .pool_max_idle_per_host(4)
                    .tcp_keepalive(Duration::from_secs(60))
                    // ★ 这里是「图片」专用 client，绝不能设 7200s（2 小时）。
                    //   图片代理与 FLV/HLS 转发共用同一个 actix HttpServer，
                    //   而 actix 的 worker 数 = CPU 核数，是**共享**的。
                    //   列表滚动一次就能并发几十个 /image 请求，只要上游 CDN 挂住，
                    //   每个请求会占住一个 worker 长达 2 小时 —— 几十个就足以耗尽
                    //   worker 池，/live.flv 与 /hls 跟着一起卡死，
                    //   表现为「看直播突然整个画面冻住」。
                    //   图片是小资源，20s 拿不到就是失败，重远低于拖垮播放的代价。
                    .timeout(Duration::from_secs(20))
                    .build()
                    .expect("failed to build client"),
            );
            // 走系统代理的客户端（Twitch 等海外平台回源用）
            let app_data_system_client = web::Data::new(SystemProxyHttpClient(
                Client::builder()
                    .http1_only()
                    .pool_max_idle_per_host(8)
                    .tcp_keepalive(Duration::from_secs(60))
                    .timeout(Duration::from_secs(30))
                    .build()
                    .expect("failed to build system proxy client"),
            ));
            App::new()
                .app_data(app_data_stream_url)
                .app_data(app_data_reqwest_client)
                .app_data(app_data_system_client)
                .wrap(actix_cors::Cors::permissive())
                .route("/live.flv", web::get().to(flv_proxy_handler))
                .route("/image", web::get().to(image_proxy_handler))
                .route("/hls", web::get().to(hls_proxy_handler))
        })
        .keep_alive(Duration::from_secs(120))
        .bind(("127.0.0.1", bound_port))
    }

    // 逐个候选端口尝试，直到 bind 成功。
    // 不再「遇到 AddrInUse 就假定已运行」—— 那正是错误 base 被永久缓存的源头。
    let mut server = None;
    let mut bound_port = 0u16;
    let mut last_err: Option<std::io::Error> = None;
    for candidate in PORT_CANDIDATES {
        match build_server(candidate, stream_url_store.inner().clone()) {
            Ok(srv) => {
                server = Some(srv);
                bound_port = candidate;
                break;
            }
            Err(e) => {
                eprintln!("[Rust/proxy.rs] 端口 {} 绑定失败，尝试下一个: {}", candidate, e);
                last_err = Some(e);
            }
        }
    }

    let server = match server {
        Some(srv) => srv,
        None => {
            let msg = format!(
                "[Rust/proxy.rs] 所有候选端口均绑定失败: {}",
                last_err
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            eprintln!("{}", msg);
            return Err(msg);
        }
    };

    // 记录真实 base，供后续幂等调用复用
    let base = format!("http://127.0.0.1:{}", bound_port);
    *static_proxy_base_cell().lock().unwrap() = Some(base.clone());

    // ★ 不需要（也不能）再调 .run()：HttpServer::bind() 返回的已经是
    //   actix_web::dev::Server，直接 await 它即启动。
    // Do NOT overwrite the main proxy server handle; run static proxy independently

    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.await {
            eprintln!("[Rust/proxy.rs] Proxy server run error: {}", e);
        } else {
            println!("[Rust/proxy.rs] Proxy server on port {} shut down.", bound_port);
        }
    });

    Ok(base)
}

#[tauri::command]
pub async fn stop_proxy(server_handle_state: State<'_, ProxyServerHandle>) -> Result<(), String> {
    // Ensure MutexGuard is dropped before .await
    let handle_to_stop = { server_handle_state.0.lock().unwrap().take() };

    if let Some(handle) = handle_to_stop {
        handle.stop(false).await; // Changed to non-graceful shutdown
        println!("[Rust/proxy.rs] stop_proxy: Initiated non-graceful shutdown.");
    } else {
        println!("[Rust/proxy.rs] stop_proxy command: No proxy server was running or handle already taken.");
    }
    Ok(())
}
