mod ssh;

use ssh::{ActiveTunnel, ConnectionState, Endpoints, SshError, SshProfileConfig};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

/// Managed SSH state: the live tunnel plus the supervisor task watching it.
/// The passphrase (if any) stays only in this in-memory struct.
struct SshState {
    inner: Arc<Mutex<SshInner>>,
}

#[derive(Default)]
struct SshInner {
    tunnel: Option<ActiveTunnel>,
    supervisor: Option<tokio::task::JoinHandle<()>>,
    profile: Option<SshProfileConfig>,
    passphrase: Option<String>,
}

impl SshInner {
    fn teardown(&mut self) {
        if let Some(t) = self.tunnel.take() {
            t.shutdown();
        }
        if let Some(s) = self.supervisor.take() {
            s.abort();
        }
    }
}

fn emit_status(app: &tauri::AppHandle, state: ConnectionState) {
    let _ = app.emit("connection-status", state);
}

/// Watchdog: probe the forwarded API port every 5s. On failure, tear the
/// tunnel down and reconnect with backoff, emitting status events throughout.
async fn supervise(app: tauri::AppHandle, inner: Arc<Mutex<SshInner>>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        let api_url = {
            let guard = inner.lock().await;
            match &guard.tunnel {
                Some(t) => t.endpoints.api.clone(),
                None => return, // disconnected elsewhere
            }
        };

        if ssh::probe_endpoint(&api_url).await {
            continue;
        }

        emit_status(&app, ConnectionState::Reconnecting);
        {
            let mut guard = inner.lock().await;
            if let Some(t) = guard.tunnel.take() {
                t.shutdown();
            }
        }

        let mut attempt: u32 = 0;
        loop {
            let (profile, passphrase) = {
                let guard = inner.lock().await;
                match &guard.profile {
                    Some(p) => (p.clone(), guard.passphrase.clone()),
                    None => return,
                }
            };
            match ssh::connect_tunnel(&profile, passphrase.as_deref()).await {
                Ok(tunnel) => {
                    let endpoints = tunnel.endpoints.clone();
                    inner.lock().await.tunnel = Some(tunnel);
                    let _ = app.emit("endpoints-changed", endpoints);
                    emit_status(&app, ConnectionState::Connected);
                    break;
                }
                Err(_) => {
                    emit_status(&app, ConnectionState::Disconnected);
                    let delay = ssh::backoff_delay_ms(attempt);
                    attempt = attempt.saturating_add(1);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    emit_status(&app, ConnectionState::Reconnecting);
                }
            }
        }
    }
}

#[tauri::command]
async fn connect_ssh(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    profile: SshProfileConfig,
    passphrase: Option<String>,
) -> Result<Endpoints, String> {
    let inner = Arc::clone(&state.inner);
    {
        let mut guard = inner.lock().await;
        guard.teardown();
        guard.profile = Some(profile.clone());
        guard.passphrase = passphrase.clone();
    }

    emit_status(&app, ConnectionState::Reconnecting);
    match ssh::connect_tunnel(&profile, passphrase.as_deref()).await {
        Ok(tunnel) => {
            let endpoints = tunnel.endpoints.clone();
            let mut guard = inner.lock().await;
            guard.tunnel = Some(tunnel);
            guard.supervisor = Some(tokio::spawn(supervise(app.clone(), Arc::clone(&inner))));
            emit_status(&app, ConnectionState::Connected);
            Ok(endpoints)
        }
        Err(e) => {
            emit_status(&app, ConnectionState::Disconnected);
            match e {
                SshError::PassphraseRequired => Err("PASSPHRASE_REQUIRED".into()),
                other => Err(other.to_string()),
            }
        }
    }
}

#[tauri::command]
async fn disconnect_ssh(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    guard.teardown();
    guard.profile = None;
    guard.passphrase = None;
    emit_status(&app, ConnectionState::Disconnected);
    Ok(())
}

#[tauri::command]
async fn get_active_endpoints(
    state: tauri::State<'_, SshState>,
) -> Result<Option<Endpoints>, String> {
    let guard = state.inner.lock().await;
    Ok(guard.tunnel.as_ref().map(|t| t.endpoints.clone()))
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("anima-tray")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("ANIMA")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(SshState { inner: Arc::new(Mutex::new(SshInner::default())) })
        .invoke_handler(tauri::generate_handler![
            connect_ssh,
            disconnect_ssh,
            get_active_endpoints
        ])
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close hides to tray; Quit in the tray menu exits for real.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ANIMA Desktop");
}
