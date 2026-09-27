// mpv_player.rs — MPV(libmpv) 播放内核集成（视频解码渲染完全移出 WebView2）
//
// 设计要点：
// - libmpv-2.dll 运行时加载（libloading）：DLL 缺失 / 初始化失败一律返回 Err，前端自动回退 WebView2 内核
// - 视频窗口：主窗口下的原生子窗口，z-order 压到最底（WebView2 之下）；
//   WebView2 与窗口在创建时就开启透明（tauri.conf.json transparent:true），
//   播放时视频区域 DOM 背景清空（"透明洞"，由 player.css + JS 打标控制），露出 mpv 画面
// - 弹幕 / 控制条仍是 WebView2 里的 DOM，覆盖在视频上方（弹幕层在洞内、控制条自带背景）
// - 事件线程 200ms 超时轮询 mpv_wait_event，把 START/END/IDLE/SHUTDOWN 广播给前端；
//   前端另有 watchdog 轮询 mpv_time_pos_cmd 判断"真的在播"
//
// mpv_event_id 数值（client.h）：SHUTDOWN=1, IDLE=11, START_FILE=26, END_FILE=27
// mpv_format：DOUBLE=5（time-pos 读取用）

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub const MPV_DLL_NAME: &str = "libmpv-2.dll";
pub const UA_CHROME: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Serialize, Clone)]
pub struct MpvEventPayload {
    pub kind: String, // "start" | "end" | "idle" | "shutdown"
}

#[derive(Deserialize, Clone, Copy, Serialize, Debug)]
pub struct MpvRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Default, Clone)]
pub struct MpvManager(Arc<Mutex<Option<MpvSession>>>);

#[repr(C)]
struct MpvHandle {
    _private: [u8; 0],
}

#[repr(C)]
struct MpvEvent {
    event_id: i32,
    flags: i32,
    reply_userdata: u64,
    data: *mut c_void,
}

// 事件线程持有裸指针的包装（mpv 官方支持跨线程 command/属性访问，仅 wait_event 限单线程）
#[repr(transparent)]
struct SendMpvHandle(*mut MpvHandle);
unsafe impl Send for SendMpvHandle {}

#[derive(Clone, Copy)]
struct Symbols {
    create: unsafe extern "C" fn() -> *mut MpvHandle,
    initialize: unsafe extern "C" fn(*mut MpvHandle) -> i32,
    terminate_destroy: unsafe extern "C" fn(*mut MpvHandle),
    set_property_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> i32,
    command: unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> i32,
    wait_event: unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent,
    get_property: unsafe extern "C" fn(*mut MpvHandle, *const c_char, i32, *mut c_void) -> i32,
}

struct MpvSession {
    _lib: libloading::Library,
    syms: Symbols,
    handle: *mut MpvHandle,
    child_hwnd: isize,
    stop_flag: Arc<AtomicBool>,
    event_thread: Option<std::thread::JoinHandle<()>>,
}

// mpv 句柄跨线程使用是官方支持的（wait_event 限定单线程，我们只在事件线程调用它）
unsafe impl Send for MpvSession {}
unsafe impl Sync for MpvSession {}

impl MpvSession {
    fn shutdown(mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(t) = self.event_thread.take() {
            let _ = t.join();
        }
        unsafe {
            (self.syms.terminate_destroy)(self.handle);
        }
        // 子窗口持久复用：不能跨线程 DestroyWindow（Win32 限定窗口只能由创建线程销毁，
        // 而 mpv_play_cmd 跑在 spawn_blocking 线程、stop 跑在异步运行时线程）。
        // 跨线程 ShowWindow 是合法的（异步投递），隐藏即可；窗口留给下一次会话复用。
        #[cfg(windows)]
        hide_video_child(self.child_hwnd);
    }
}

// 持久子窗口句柄：整个进程生命周期只创建一次，各会话复用，退出时随进程回收
#[cfg(windows)]
static PERSISTENT_CHILD_HWND: OnceLock<isize> = OnceLock::new();

#[cfg(windows)]
fn hide_video_child(hwnd: isize) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    unsafe { ShowWindow(hwnd as HWND, SW_HIDE) };
}

#[cfg(windows)]
unsafe fn load_symbols() -> Result<(libloading::Library, Symbols), String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(MPV_DLL_NAME));
        }
    }
    candidates.push(std::path::PathBuf::from(MPV_DLL_NAME));

    let mut last_err = format!("{} not found in search paths", MPV_DLL_NAME);
    for path in candidates {
        match unsafe { libloading::Library::new(&path) } {
            Ok(lib) => {
                let syms = Symbols {
                    create: *unsafe { lib.get(b"mpv_create") }.map_err(|e| e.to_string())?,
                    initialize: *unsafe { lib.get(b"mpv_initialize") }.map_err(|e| e.to_string())?,
                    terminate_destroy: *unsafe { lib.get(b"mpv_terminate_destroy") }
                        .map_err(|e| e.to_string())?,
                    set_property_string: *unsafe { lib.get(b"mpv_set_property_string") }
                        .map_err(|e| e.to_string())?,
                    command: *unsafe { lib.get(b"mpv_command") }.map_err(|e| e.to_string())?,
                    wait_event: *unsafe { lib.get(b"mpv_wait_event") }.map_err(|e| e.to_string())?,
                    get_property: *unsafe { lib.get(b"mpv_get_property") }.map_err(|e| e.to_string())?,
                };
                return Ok((lib, syms));
            }
            Err(e) => {
                last_err = format!("{}: {}", path.display(), e);
            }
        }
    }
    Err(last_err)
}

#[cfg(not(windows))]
unsafe fn load_symbols() -> Result<(libloading::Library, Symbols), String> {
    Err("MPV engine is only supported on Windows".into())
}

unsafe fn mpv_set_str(syms: &Symbols, h: *mut MpvHandle, name: &str, value: &str) -> Result<(), String> {
    let n = CString::new(name).map_err(|e| e.to_string())?;
    let v = CString::new(value).map_err(|e| e.to_string())?;
    let rc = unsafe { (syms.set_property_string)(h, n.as_ptr(), v.as_ptr()) };
    if rc < 0 {
        Err(format!("mpv set_property_string({}) failed rc={}", name, rc))
    } else {
        Ok(())
    }
}

unsafe fn mpv_command(syms: &Symbols, h: *mut MpvHandle, args: &[&str]) -> Result<(), String> {
    let cargs: Vec<CString> = args
        .iter()
        .map(|a| CString::new(*a).unwrap_or_default())
        .collect();
    let mut ptrs: Vec<*const c_char> = cargs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let rc = unsafe { (syms.command)(h, ptrs.as_ptr()) };
    if rc < 0 {
        Err(format!(
            "mpv_command({:?}) failed rc={}",
            args.first().unwrap_or(&""),
            rc
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
unsafe fn create_video_child(parent_hwnd: isize, rect: &MpvRect) -> Result<isize, String> {
    use windows_sys::Win32::Foundation::{GetLastError, HWND};
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WS_CHILD, WS_VISIBLE, WNDCLASSW,
    };

    static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();
    let class_w: Vec<u16> = "dtv_x_mpv_video\0".encode_utf16().collect();

    CLASS_REGISTERED.get_or_init(|| {
        let mut wc: WNDCLASSW = unsafe { std::mem::zeroed() };
        wc.lpfnWndProc = Some(DefWindowProcW);
        wc.hInstance = unsafe { GetModuleHandleW(std::ptr::null()) };
        wc.hbrBackground = unsafe { GetStockObject(BLACK_BRUSH) } as _;
        wc.lpszClassName = class_w.as_ptr();
        unsafe { RegisterClassW(&wc) };
    });

    let title_w: Vec<u16> = "dtv_x_mpv_video\0".encode_utf16().collect();
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_w.as_ptr(),
            title_w.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            rect.x.max(0),
            rect.y.max(0),
            rect.width.max(2),
            rect.height.max(2),
            parent_hwnd as HWND,
            std::ptr::null_mut(),
            unsafe { GetModuleHandleW(std::ptr::null()) },
            std::ptr::null(),
        )
    };
    if hwnd.is_null() {
        return Err(format!("CreateWindowExW failed, GetLastError={}", unsafe { GetLastError() }));
    }

    // z-order 压到最底：mpv 位于 WebView2 之下，WebView2 透明区域露出 mpv 画面
    unsafe {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    Ok(hwnd as isize)
}

#[cfg(not(windows))]
unsafe fn create_video_child(_parent_hwnd: isize, _rect: &MpvRect) -> Result<isize, String> {
    Err("MPV engine is only supported on Windows".into())
}

// 主窗口 HWND：tauri 返回 windows crate 的 HWND（新类型，repr(transparent)）。
// 用指针重读的方式取 isize，兼容"裸指针"与"新类型"两种定义。
#[cfg(windows)]
fn main_window_hwnd(app: &AppHandle) -> Result<isize, String> {
    let window = app.get_webview_window("main").ok_or("main window not found")?;
    let h = window.hwnd().map_err(|e| e.to_string())?;
    let as_isize = unsafe { (&h as *const _ as *const isize).read() };
    Ok(as_isize)
}

// WebView2 透明由 tauri.conf.json 的 `"transparent": true` 在创建时一次性开启（wry 会在
// controller 创建阶段与 init_webview 两次写入 DefaultBackgroundColor(0,0,0,0)，这是唯一
// 经过验证可靠的透明路径）。运行时 `set_background_color` 在 Windows 上还会同时把
// "窗口层"背景改为不透明色（alpha 被忽略），行为不可控，故不再运行时切换——
// DOM 侧由 player.css 的 `body.mpv-active` / `.mpv-hole` 负责"透明洞"的开关。

static CREATE_LOCK: Mutex<()> = Mutex::new(());

// 获取（或创建）持久视频子窗口：复用时重新定位并显示
#[cfg(windows)]
unsafe fn acquire_video_child(parent_hwnd: isize, rect: &MpvRect) -> Result<isize, String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SW_SHOW,
    };

    if let Some(&existing) = PERSISTENT_CHILD_HWND.get() {
        unsafe {
            // 复用时一次性完成"重新定位 + 显示 + 压回 z-order 最底"。
            // 必须再次压底：WebView2 在会话切换中可能被系统/前端操作提到更高 z-order，
            // 一旦盖住 mpv 子窗口就会出现"只有声音没有画面"。
            SetWindowPos(
                existing as HWND,
                HWND_BOTTOM,
                rect.x.max(0),
                rect.y.max(0),
                rect.width.max(2),
                rect.height.max(2),
                SWP_NOACTIVATE,
            );
            ShowWindow(existing as HWND, SW_SHOW);
        }
        return Ok(existing);
    }
    let hwnd = unsafe { create_video_child(parent_hwnd, rect)? };
    let _ = PERSISTENT_CHILD_HWND.set(hwnd);
    Ok(hwnd)
}

#[cfg(not(windows))]
unsafe fn acquire_video_child(_parent_hwnd: isize, _rect: &MpvRect) -> Result<isize, String> {
    Err("MPV engine is only supported on Windows".into())
}

#[cfg(windows)]
unsafe fn start_session(
    app: &AppHandle,
    sessions: &Arc<Mutex<Option<MpvSession>>>,
    url: &str,
    headers: &HashMap<String, String>,
    rect: &MpvRect,
) -> Result<(), String> {
    let _create_guard = CREATE_LOCK.lock().map_err(|e| e.to_string())?;

    // 停掉旧会话
    {
        let mut g = sessions.lock().map_err(|e| e.to_string())?;
        if let Some(old) = g.take() {
            old.shutdown();
        }
    }

    let (lib, syms) = unsafe { load_symbols() }?;
    let parent = main_window_hwnd(app)?;
    let child = unsafe { acquire_video_child(parent, rect) }?;

    // 出错统一清理：销毁 mpv 句柄（子窗口保留隐藏，供下次复用）
    macro_rules! fail {
        ($handle:expr, $err:expr) => {{
            unsafe { (syms.terminate_destroy)($handle) };
            #[cfg(windows)]
            hide_video_child(child);
            return Err($err);
        }};
    }

    let handle = unsafe { (syms.create)() };
    if handle.is_null() {
        hide_video_child(child);
        return Err("mpv_create returned null".into());
    }

    // initialize 之前的选项（wid 必须在初始化前设置）
    // 内存优化：直播流不需要大缓冲，显式收紧 demuxer 缓存
    // （mpv 默认 demuxer-max-bytes 可达 150MiB，直播场景 32MiB 前向 + 8MiB 后向足够流畅）
    let pre_init: [(&str, String); 12] = [
        ("wid", child.to_string()),
        ("hwdec", "auto".into()),
        ("cache", "yes".into()),
        ("demuxer-max-bytes", "33554432".into()),
        ("demuxer-max-back-bytes", "8388608".into()),
        ("demuxer-readahead-secs", "10".into()),
        ("terminal", "no".into()),
        ("audio-display", "no".into()),
        ("input-default-bindings", "no".into()),
        ("user-agent", UA_CHROME.into()),
        ("pause", "no".into()),
        ("volume", "100".into()),
    ];
    for (k, v) in pre_init.iter() {
        if let Err(e) = unsafe { mpv_set_str(&syms, handle, k, v) } {
            fail!(handle, e);
        }
    }

    if unsafe { (syms.initialize)(handle) } < 0 {
        fail!(handle, "mpv_initialize failed".to_string());
    }

    // 每个流的自定义 header（如 B 站 Referer）通过 loadfile 的 per-file options 传入
    let mut load_args: Vec<String> = vec!["loadfile".into(), url.to_string(), "replace".into()];
    if !headers.is_empty() {
        let pairs: Vec<String> = headers.iter().map(|(k, v)| format!("{}: {}", k, v)).collect();
        load_args.push(format!("http-header-fields={}", pairs.join(",")));
    }
    let arg_refs: Vec<&str> = load_args.iter().map(|s| s.as_str()).collect();
    if let Err(e) = unsafe { mpv_command(&syms, handle, &arg_refs) } {
        fail!(handle, e);
    }

    // 事件线程：广播 START/END/IDLE/SHUTDOWN 给前端
    let stop_flag = Arc::new(AtomicBool::new(false));
    let ev_app = app.clone();
    let ev_stop = stop_flag.clone();
    let ev_syms = syms;
    let ev_handle = SendMpvHandle(handle);
    let thread = std::thread::spawn(move || {
        let ev_handle = ev_handle;
        loop {
            if ev_stop.load(Ordering::Relaxed) {
                break;
            }
            let ev = unsafe { (ev_syms.wait_event)(ev_handle.0, 0.2) };
            if ev.is_null() {
                continue;
            }
            let id = unsafe { (*ev).event_id };
            let kind = match id {
                26 => Some("start"),   // MPV_EVENT_START_FILE
                27 => Some("end"),     // MPV_EVENT_END_FILE
                11 => Some("idle"),    // MPV_EVENT_IDLE
                1 => Some("shutdown"), // MPV_EVENT_SHUTDOWN
                _ => None,
            };
            if let Some(kind) = kind {
                let _ = ev_app.emit("mpv-event", MpvEventPayload { kind: kind.to_string() });
                if kind == "shutdown" {
                    break;
                }
            }
        }
    });

    let session = MpvSession {
        _lib: lib,
        syms,
        handle,
        child_hwnd: child,
        stop_flag,
        event_thread: Some(thread),
    };
    *sessions.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(())
}

#[cfg(not(windows))]
unsafe fn start_session(
    _app: &AppHandle,
    _sessions: &Arc<Mutex<Option<MpvSession>>>,
    _url: &str,
    _headers: &HashMap<String, String>,
    _rect: &MpvRect,
) -> Result<(), String> {
    Err("MPV engine is only supported on Windows".into())
}

fn with_session<R>(
    manager: &MpvManager,
    f: impl FnOnce(Option<&MpvSession>) -> R,
) -> Result<R, String> {
    let g = manager.0.lock().map_err(|e| e.to_string())?;
    Ok(f(g.as_ref()))
}

// ===================== Tauri 命令 =====================

#[tauri::command]
pub async fn mpv_is_available_cmd() -> Result<bool, String> {
    #[cfg(windows)]
    {
        Ok(unsafe { load_symbols() }.is_ok())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub async fn mpv_play_cmd(
    app: AppHandle,
    manager: State<'_, MpvManager>,
    url: String,
    headers: Option<HashMap<String, String>>,
    rect: MpvRect,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sessions = manager.0.clone();
        let hmap = headers.unwrap_or_default();
        let res = tokio::task::spawn_blocking(move || {
            unsafe { start_session(&app, &sessions, &url, &hmap, &rect) }
        })
        .await
        .map_err(|e| format!("mpv play join error: {}", e))?;
        res
    }
    #[cfg(not(windows))]
    {
        let _ = (app, manager, url, headers, rect);
        Err("MPV engine is only supported on Windows".into())
    }
}

#[tauri::command]
pub async fn mpv_stop_cmd(app: AppHandle, manager: State<'_, MpvManager>) -> Result<(), String> {
    // app 保留在签名中以兼容既有前端调用；透明/背景恢复已全部由 DOM 侧 CSS 处理
    let _ = &app;
    let old = {
        let mut g = manager.0.lock().map_err(|e| e.to_string())?;
        g.take()
    };
    if let Some(s) = old {
        s.shutdown();
    }
    Ok(())
}

#[tauri::command]
pub async fn mpv_set_rect_cmd(manager: State<'_, MpvManager>, rect: MpvRect) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };
        with_session(&manager, |s| {
            if let Some(sess) = s {
                unsafe {
                    SetWindowPos(
                        sess.child_hwnd as HWND,
                        std::ptr::null_mut(),
                        rect.x,
                        rect.y,
                        rect.width.max(2),
                        rect.height.max(2),
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
            }
        })?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, rect);
        Ok(())
    }
}

#[tauri::command]
pub async fn mpv_pause_cmd(manager: State<'_, MpvManager>, paused: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let r = with_session(&manager, |s| {
            if let Some(sess) = s {
                unsafe { mpv_set_str(&sess.syms, sess.handle, "pause", if paused { "yes" } else { "no" })? };
            }
            Ok(())
        })?;
        return r;
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, paused);
        Ok(())
    }
}

#[tauri::command]
pub async fn mpv_set_volume_cmd(manager: State<'_, MpvManager>, volume: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        let r = with_session(&manager, |s| {
            if let Some(sess) = s {
                unsafe { mpv_set_str(&sess.syms, sess.handle, "volume", &format!("{}", volume))? };
            }
            Ok(())
        })?;
        return r;
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, volume);
        Ok(())
    }
}

#[tauri::command]
pub async fn mpv_set_mute_cmd(manager: State<'_, MpvManager>, muted: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let r = with_session(&manager, |s| {
            if let Some(sess) = s {
                unsafe { mpv_set_str(&sess.syms, sess.handle, "mute", if muted { "yes" } else { "no" })? };
            }
            Ok(())
        })?;
        return r;
    }
    #[cfg(not(windows))]
    {
        let _ = (manager, muted);
        Ok(())
    }
}

// 前端 watchdog 用：time-pos > 0 表示真的在播
#[tauri::command]
pub async fn mpv_time_pos_cmd(manager: State<'_, MpvManager>) -> Result<Option<f64>, String> {
    #[cfg(windows)]
    {
        let r = with_session(&manager, |s| {
            if let Some(sess) = s {
                let name = CString::new("time-pos").unwrap_or_default();
                let mut out: f64 = 0.0;
                let rc = unsafe {
                    (sess.syms.get_property)(
                        sess.handle,
                        name.as_ptr(),
                        5, // MPV_FORMAT_DOUBLE
                        &mut out as *mut f64 as *mut c_void,
                    )
                };
                if rc == 0 {
                    return Ok(Some(out));
                }
            }
            Ok(None)
        })?;
        return r;
    }
    #[cfg(not(windows))]
    {
        let _ = manager;
        Ok(None)
    }
}
