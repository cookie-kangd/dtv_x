// 退出时清理缓存（对齐 dtv_mx 的 AppCacheCleaner 语义）。
//
// 刻意只清理 WebView2 用户数据目录中的「纯缓存」子目录（HTTP 磁盘缓存、
// 代码缓存、GPU 着色器缓存、崩溃转储），绝不触碰：
// - Cookies / Network（B站等登录态）
// - Local Storage / Session Storage / IndexedDB（应用设置、关注列表等）
// 因此清理不会影响稳定性与任何账号登录状态。
//
// 清理为 best-effort：退出阶段 WebView2 进程正在关闭，个别目录可能仍被
// 短暂锁住，删除失败直接忽略（下次退出再清），绝不阻塞退出流程。
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

/// 「退出时清理缓存」开关（前端设置同步过来，默认开）。
#[derive(Default)]
pub struct ExitCleanupFlag(pub AtomicBool);

#[tauri::command]
pub async fn set_exit_cleanup_enabled(
    enabled: bool,
    flag: State<'_, ExitCleanupFlag>,
) -> Result<(), String> {
    flag.0.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// WebView2 数据目录下可以安全整目录删除的缓存路径（相对路径）。
const SAFE_CACHE_SUBDIRS: &[&str] = &[
    // Chromium 默认 profile 的缓存
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "Default/Service Worker/CacheStorage",
    "Default/Service Worker/ScriptCache",
    // profile 之外的着色器/图形缓存
    "GrShaderCache",
    "ShaderCache",
    "GraphiteDawnCache",
    "Crashpad/reports",
    "Crashpad/completed",
];

fn delete_dir_contents_best_effort(dir: &PathBuf) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        let is_dir = p.is_dir();
        // 三次重试，避开退出瞬间短暂的文件锁
        for attempt in 0..3 {
            let ok = if is_dir {
                std::fs::remove_dir_all(&p).is_ok()
            } else {
                std::fs::remove_file(&p).is_ok()
            };
            if ok {
                removed += 1;
                break;
            }
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    removed
}

/// 退出时执行缓存清理（仅当开关开启时生效）。
pub fn cleanup_on_exit(app: &AppHandle, flag: &ExitCleanupFlag) {
    if !flag.0.load(Ordering::Relaxed) {
        return;
    }
    // WebView2 用户数据目录：Tauri v2 默认放在 app_local_data_dir/EBWebView
    let Ok(local_dir) = app.path().app_local_data_dir() else {
        return;
    };
    let webview_root = local_dir.join("EBWebView");
    if !webview_root.is_dir() {
        return;
    }
    for sub in SAFE_CACHE_SUBDIRS {
        let dir = webview_root.join(sub);
        if dir.is_dir() {
            delete_dir_contents_best_effort(&dir);
        }
    }
}
