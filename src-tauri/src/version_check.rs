use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteVersionInfo {
    pub version: String,
    pub title: Option<String>,
    pub notes: Option<Vec<String>>,
    pub url: Option<String>,
    pub published_at: Option<String>,
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
                    if let Some(assets) = v["assets"].as_array() {
                        for a in assets {
                            let name = a["name"].as_str().unwrap_or("");
                            if name.starts_with("DTV_X_") && name.ends_with("_x64-setup.exe") {
                                if let Some(u) = a["browser_download_url"].as_str() {
                                    download_url = Some(format!("{}{}", MIRROR_PREFIX, u));
                                }
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
