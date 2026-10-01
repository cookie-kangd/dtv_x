use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub phase: String, // "downloading" | "installing" | "error"
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteVersionInfo {
    pub version: String,
    pub title: Option<String>,
    pub notes: Option<Vec<String>>,
    pub url: Option<String>,
    pub published_at: Option<String>,
    /// 安装包字节数（Release 资产 size）。用于判断本地是否已有完整安装包，
    /// 从而实现「重复点击不重新下载」。
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionCheckResponse {
    pub local_version: String,
    pub remote: Option<RemoteVersionInfo>,
    pub has_update: bool,
}

fn parse_semver_parts(v: &str) -> [i32; 3] {
    let cleaned = v.trim().trim_start_matches(['v', 'V']);
    let mut out = [0_i32; 3];
    for (idx, part) in cleaned.split('.').take(3).enumerate() {
        out[idx] = part.parse::<i32>().unwrap_or(0);
    }
    out
}

fn is_remote_newer(remote: &str, local: &str) -> bool {
    let r = parse_semver_parts(remote);
    let l = parse_semver_parts(local);
    r > l
}

#[tauri::command]
pub async fn check_version_cmd(
    app_handle: tauri::AppHandle,
    client: State<'_, reqwest::Client>,
) -> Result<VersionCheckResponse, String> {
    let local_version = app_handle.package_info().version.to_string();

    // dtv_x 更新检查：直接读本仓库 GitHub 最新 Release，
    // 下载链接自动拼 gh-proxy 镜像前缀，国内网络可加速下载。
    const RELEASES_API: &str = "https://api.github.com/repos/cookie-kangd/dtv_x/releases/latest";
    const MIRROR_PREFIX: &str = "https://v4.gh-proxy.org/";
    const RELEASES_PAGE: &str = "https://github.com/cookie-kangd/dtv_x/releases";

    let remote: Option<RemoteVersionInfo> = match client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "dtv_x-updater")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(v) => {
                let tag = v["tag_name"].as_str().unwrap_or("").trim().to_string();
                let version = tag.trim_start_matches('v').to_string();
                if version.is_empty() {
                    None
                } else {
                    // 找 Windows x64 NSIS 安装包资产，拼镜像前缀作为下载地址；
                    // 找不到资产时回退到 Releases 页面
                    let mut download_url: Option<String> = None;
                    let mut download_size: Option<u64> = None;
                    if let Some(assets) = v["assets"].as_array() {
                        for a in assets {
                            let name = a["name"].as_str().unwrap_or("");
                            if name.starts_with("DTV_X_") && name.ends_with("_x64-setup.exe") {
                                if let Some(u) = a["browser_download_url"].as_str() {
                                    download_url = Some(format!("{}{}", MIRROR_PREFIX, u));
                                }
                                download_size = a["size"].as_u64();
                                break;
                            }
                        }
                    }
                    let url = download_url.unwrap_or_else(|| RELEASES_PAGE.to_string());

                    // release body 按行整理为更新日志（去掉标题行和空行）
                    let notes = v["body"].as_str().map(|b| {
                        b.lines()
                            .map(|l| l.trim().to_string())
                            .filter(|l| !l.is_empty() && !l.starts_with('#'))
                            .take(10)
                            .collect::<Vec<String>>()
                    });
                    let title = v["name"]
                        .as_str()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let published_at = v["published_at"].as_str().map(|s| {
                        // 只取日期部分（ISO 8601 前 10 位）
                        s.chars().take(10).collect::<String>()
                    });

                    Some(RemoteVersionInfo {
                        version,
                        title,
                        notes,
                        url: Some(url),
                        published_at,
                        size: download_size,
                    })
                }
            }
            _ => None,
        },
        _ => None,
    };

    let has_update = remote
        .as_ref()
        .map(|r| is_remote_newer(&r.version, &local_version))
        .unwrap_or(false);

    Ok(VersionCheckResponse {
        local_version,
        remote,
        has_update,
    })
}

const MIRROR_PREFIX: &str = "https://v4.gh-proxy.org/";

/// 安装包落盘目录。
/// 固定子目录（而非每次新建临时文件），这样「下载完成但安装没启动成功」时，
/// 再次点击「立即更新」可以直接复用已下载的包，不会重新下载。
fn installer_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("dtv_x-updater");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 判断本地已有安装包是否完整可用。
/// expected_size 来自 Release 资产 size；缺失时退化为「文件大于 1MB 即认为可用」。
fn install_package_ready(path: &std::path::Path, expected_size: Option<u64>) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => match expected_size {
            Some(s) if s > 0 => meta.len() == s,
            _ => meta.len() > 1024 * 1024,
        },
        _ => false,
    }
}

/// 以「延迟 + 分离进程」方式启动 NSIS 安装向导，随后立刻退出本应用。
///
/// 为什么要延迟：本应用退出需要一点时间（WebView2 子进程回收等），若安装程序
/// 立刻起来，其初始化阶段可能检测到「应用仍在运行」而弹出确认框。延迟 2 秒启动，
/// 保证安装向导看到的是一个已经退干净的进程，用户直接一路下一步即可。
///
/// 为什么用 cmd + ping 做延迟：分离进程里没有控制台，`timeout` 会报
/// 「不支持输入重定向」，`ping -n` 是无需控制台的通用延时手段。
fn launch_installer_detached(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        // ping 127.0.0.1 -n 3 ≈ 2 秒
        let script = format!(
            "ping 127.0.0.1 -n 3 >nul & start \"\" \"{}\"",
            path.display()
        );
        let spawned = std::process::Command::new("cmd")
            .arg("/C")
            .arg(script)
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .spawn();
        if spawned.is_ok() {
            return Ok(());
        }
        // 分离启动失败时回退为直接启动（此时文件句柄已关闭，不会被文件占用拦住）
        std::process::Command::new(path).spawn().map(|_| ())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(path).spawn().map(|_| ())
    }
}

// 应用内一键更新：下载安装包（镜像优先、直连兜底，带进度事件）→ 启动 NSIS 安装程序 → 退出应用
// 注意：State 为借用参数，在 async command 中必须置于最后
#[tauri::command]
pub async fn download_and_install_cmd(
    app: AppHandle,
    url: String,
    version: String,
    size: Option<u64>,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let version_clean = version.trim().trim_start_matches('v').to_string();
    let file_name = format!("DTV_X_{}_x64-setup.exe", version_clean);
    let dir = installer_dir();
    let path = dir.join(&file_name);

    let emit_progress = |phase: &str, downloaded: u64, total: u64, msg: Option<String>| {
        let percent = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit(
            "update-progress",
            UpdateProgress {
                phase: phase.to_string(),
                downloaded,
                total,
                percent,
                message: msg,
            },
        );
    };

    // ① 本地已有完整安装包 → 跳过下载直接安装（避免「再次点击又重新下载」）
    if install_package_ready(&path, size) {
        let cached = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        emit_progress(
            "installing",
            cached,
            size.unwrap_or(cached),
            Some("安装包已下载完成，正在退出本应用并启动安装向导…".into()),
        );
        return launch_installer(&app, &path).await;
    }

    // 候选地址：镜像优先，失败回退直连
    let mut candidates: Vec<String> = Vec::new();
    if !url.trim().is_empty() {
        candidates.push(url.trim().to_string());
        if let Some(direct) = url.trim().strip_prefix(MIRROR_PREFIX) {
            candidates.push(direct.to_string());
        }
    }
    if candidates.is_empty() {
        return Err("no download url provided".into());
    }

    let part_path = dir.join(format!("{}.part", file_name));
    let mut last_err = String::from("download failed");

    for candidate in candidates.iter() {
        let resp = match client
            .get(candidate)
            .header("User-Agent", "dtv_x-updater")
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("HTTP {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };

        let total = resp.content_length().unwrap_or(0);
        let _ = std::fs::remove_file(&part_path);
        let mut downloaded: u64 = 0;

        // 关键：下载写入放在独立作用域里，作用域结束时 BufWriter 与其持有的 File
        // 会被释放（文件句柄关闭）。否则带着「写模式」的句柄去启动安装包，
        // Windows 映射可执行镜像时会直接报
        // 「另一个程序正在使用此文件，进程无法访问。(os error 32)」。
        {
            let file = match std::fs::File::create(&part_path) {
                Ok(f) => f,
                Err(e) => {
                    last_err = format!("create temp file failed: {}", e);
                    continue;
                }
            };
            let mut writer = std::io::BufWriter::with_capacity(1024 * 1024, file);
            let mut stream = resp.bytes_stream();
            let mut last_emit = std::time::Instant::now();
            let mut write_failed = false;

            loop {
                match stream.next().await {
                    Some(Ok(chunk)) => {
                        if let Err(e) = writer.write_all(&chunk) {
                            last_err = format!("write failed: {}", e);
                            write_failed = true;
                            break;
                        }
                        downloaded += chunk.len() as u64;
                        // 进度事件节流：最多每 120ms 一次，避免刷屏
                        if last_emit.elapsed() >= std::time::Duration::from_millis(120) {
                            last_emit = std::time::Instant::now();
                            emit_progress("downloading", downloaded, total, None);
                        }
                    }
                    Some(Err(e)) => {
                        last_err = e.to_string();
                        downloaded = 0;
                        write_failed = true;
                        break;
                    }
                    None => break,
                }
            }

            if !write_failed {
                if let Err(e) = writer.flush() {
                    last_err = format!("flush failed: {}", e);
                    write_failed = true;
                }
            }
            // writer / file 在此关闭；下方不再持有任何句柄
            if write_failed {
                let _ = std::fs::remove_file(&part_path);
                continue;
            }
        }

        if downloaded == 0 {
            let _ = std::fs::remove_file(&part_path);
            last_err = "downloaded 0 bytes".to_string();
            continue; // 该候选地址失败，尝试下一个
        }
        if total > 0 && downloaded < total {
            let _ = std::fs::remove_file(&part_path);
            last_err = format!("incomplete download: {}/{}", downloaded, total);
            continue;
        }

        // 原子改名：只有完整下载的文件才会变成正式安装包，
        // 这样下次点击时 install_package_ready 才能可靠地复用它
        let _ = std::fs::remove_file(&path);
        if let Err(e) = std::fs::rename(&part_path, &path) {
            last_err = format!("finalize installer failed: {}", e);
            let _ = std::fs::remove_file(&part_path);
            continue;
        }

        // 下载完成 → 释放句柄后启动安装向导，并退出本应用
        emit_progress(
            "installing",
            downloaded,
            total,
            Some("下载完成，正在退出本应用并启动安装向导…".into()),
        );
        return launch_installer(&app, &path).await;
    }

    emit_progress("error", 0, 0, Some(last_err.clone()));
    Err(last_err)
}

/// 启动安装向导并立刻退出应用。
/// 退出应用是必须的：否则安装程序覆盖 dtv_x.exe 时会因文件被占用而失败。
async fn launch_installer(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    // 双保险：调用方已确保句柄关闭，这里再确认文件存在且非零
    if !path.is_file() {
        let msg = format!("安装包不存在：{}", path.display());
        let _ = app.emit(
            "update-progress",
            UpdateProgress {
                phase: "error".into(),
                downloaded: 0,
                total: 0,
                percent: 0.0,
                message: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    // 稍等一拍，让前端把「正在启动安装向导」渲染出来
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    match launch_installer_detached(path) {
        Ok(_) => {
            // 立即退出，释放 dtv_x.exe 自身占用，让安装向导可以直接覆盖安装
            app.exit(0);
            Ok(())
        }
        Err(e) => {
            let msg = format!(
                "启动安装程序失败：{}。安装包已下载到 {}，可手动双击安装。",
                e,
                path.display()
            );
            let _ = app.emit(
                "update-progress",
                UpdateProgress {
                    phase: "error".into(),
                    downloaded: 0,
                    total: 0,
                    percent: 0.0,
                    message: Some(msg.clone()),
                },
            );
            Err(msg)
        }
    }
}
