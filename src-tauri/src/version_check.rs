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
    // 镜像前缀统一用模块级那个常量，不要在此处再声明一份：
    // 同名双份常量的典型隐患就是「改了一处漏了另一处」——
    // 一旦只改下载用的那份，检查提示里拼出的镜像URL 会与实际下载逻辑不一致，
    // 表现为「提示有更新但下载 404」。
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
/// 同时校验 MZ 头：上一次下载中途断网可能留下一个长度凑巧对的残缺文件，
/// 复用它会让用户点了「立即更新」却什么都没发生。
fn install_package_ready(path: &std::path::Path, expected_size: Option<u64>) -> bool {
    let size_ok = match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => match expected_size {
            Some(s) if s > 0 => meta.len() == s,
            _ => meta.len() > 1024 * 1024,
        },
        _ => false,
    };
    size_ok && is_windows_exe(path)
}

/// 校验落盘文件确实是一个 Windows PE 可执行文件。
///
/// 必须校验：镜像站（gh-proxy）在限流、超时或路径失效时会返回 HTML 错误页，
/// 而 GitHub API 返回的 size 只保证「长度对得上」，不保证「内容是 exe」。
/// 如果把一张 HTML 错误页当安装包启动，用户看到的就是「双击后一闪而过、
/// 什么都没发生」，比直接报错更难排查。
fn is_windows_exe(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut magic = [0u8; 2];
    match f.read_exact(&mut magic) {
        Ok(()) if &magic == b"MZ" => true,
        _ => false,
    }
}

/// 判断当前进程是否运行在「正式安装目录」内。
///
/// 判据是同目录下存在 NSIS 写出的卸载器 `uninstall.exe`。
/// 结果决定谁来关闭本应用：
/// - 已安装：交给安装器自己的 Restart Manager 关闭（用户可在向导里点「否」取消，
///   此时应用还活着，体验最接近手动双击安装包）；
/// - 便携运行（exe 在下载目录等非安装位置）：必须本应用先退出，
///   否则安装器覆盖文件时必然失败。
fn running_from_install_dir() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    dir.join("uninstall.exe").is_file()
}

/// 直接启动 NSIS 安装包，等价于用户在资源管理器里双击它。
///
/// 这里绝对不能借道 `cmd /C "ping ... & start \"\" \"x.exe\""`：
/// 1. Rust 的 `Command` 按 Windows 命令行规则转义参数，内层引号会变成 `\"`，
///    而 cmd.exe 不认识反斜杠转义（它只认自己的引号规则），于是 `start` 拿到的是
///    一串带反斜杠的垃圾参数 → 弹出 CMD 窗口 + 报错，正是之前的现象。
/// 2. `CREATE_NO_WINDOW` 与 `DETACHED_PROCESS` 同时给时，前者会被系统忽略
///    （MSDN 明确：CREATE_NO_WINDOW 与 DETACHED_PROCESS 互斥），
///    所以那个黑色 CMD 窗口一定会闪出来。
/// 3. `ping` 做延时本身就不可靠，还额外引入一个 cmd 进程。
///
/// NSIS 安装包是 GUI 子系统程序，本身不会分配控制台，所以直接 spawn 它
/// 既不会闪出任何黑窗口，也不需要任何延时技巧。
///
/// 参数说明（来自 Tauri NSIS 模板）：
/// - `/UPDATE`：走「更新」分支，跳过先跑一遍旧版卸载器的步骤，
///   从而保留开始菜单/桌面快捷方式、开机自启和应用数据。
///   不传它的话，每次更新都会被当成「卸载 + 重装」，
///   既多一步交互，又可能把用户的配置数据删掉。
/// - `/P`：passive 模式，只显示一个带进度条的小窗口，不弹任何对话框，
///   并且安装前由安装器直接强制结束正在运行的旧进程（跳过「是否关闭程序」的询问）。
/// - `/R`：passive 模式安装成功后自动重启应用（passive 会跳过结束页，
///   结束页那个「运行」复选框不存在，只能靠这个开关）。
fn spawn_installer(path: &std::path::Path, silent: bool) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        let mut cmd = std::process::Command::new(path);
        cmd.arg("/UPDATE");
        if silent {
            cmd.arg("/P");
            cmd.arg("/R");
        }
        // 只给 DETACHED_PROCESS：让安装器不挂在我们的控制台/进程树上，
        // 我们退出后它继续活着跑完。
        Ok(cmd
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map(|_| ())?)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new(path);
        cmd.arg("/UPDATE");
        if silent {
            cmd.arg("/P");
            cmd.arg("/R");
        }
        Ok(cmd.spawn().map(|_| ())?)
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

/// 启动安装向导。
///
/// 两种模式，取决于当前进程是否跑在正式安装目录里：
/// - 已安装：直接启动安装器，**不退出本应用**。安装器自带 Restart Manager，
///   会在真正覆盖文件前把 DTV_X 关掉；万一用户在向导里点「否」取消安装，
///   本应用还活着，不会出现「应用没了、装也没装上」的最坏情况。
///   体验与手动双击安装包完全一致。
/// - 便携运行（exe 不在安装目录）：安装器找不到也关不掉本进程，
///   必须由我们自己退出，否则覆盖安装必然失败。
async fn launch_installer(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    let fail = |msg: String| -> Result<(), String> {
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
    };

    if !path.is_file() {
        return fail(format!("安装包不存在：{}", path.display()));
    }
    // 大小对得上不代表内容是 exe：镜像站限流时会返回一张 HTML 错误页，
    // 长度可能刚好接近。这种文件启动后什么都不会发生，必须提前拦下。
    if !is_windows_exe(path) {
        let _ = std::fs::remove_file(path);
        return fail(
            "下载到的安装包不是有效的可执行文件（可能是镜像站返回了错误页面）。\n请检查网络后重试，或点击「打开下载页」手动下载。"
                .into(),
        );
    }

    let installed = running_from_install_dir();

    // 稍等一拍，让前端把「安装向导已启动」渲染出来再动作
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    match spawn_installer(path, !installed) {
        Ok(()) => {
            if installed {
                // 已安装：安装器会自己处理本进程的关闭，这里不能退出，
                // 否则用户在向导里点「取消」就两头落空。
                // 发「launched」而不是「installing」：本应用还活着，
                // 前端必须恢复按钮可点，否则用户取消安装后就再也无法重试。
                let msg = "安装向导已启动，请按提示完成安装（DTV_X 会在覆盖文件前自动关闭）";
                let _ = app.emit(
                    "update-progress",
                    UpdateProgress {
                        phase: "launched".into(),
                        downloaded: 0,
                        total: 0,
                        percent: 100.0,
                        message: Some(msg.into()),
                    },
                );
            } else {
                // 便携运行：静默安装 + 安装完自动重启，然后退出本应用
                let msg = "正在退出本应用并静默安装…";
                let _ = app.emit(
                    "update-progress",
                    UpdateProgress {
                        phase: "installing".into(),
                        downloaded: 0,
                        total: 0,
                        percent: 100.0,
                        message: Some(msg.into()),
                    },
                );
                crate::really_quit(app);
            }
            Ok(())
        }
        Err(e) => fail(format!(
            "启动安装程序失败：{}。\n安装包已保存到 {}，可手动双击安装。",
            e,
            path.display()
        )),
    }
}
