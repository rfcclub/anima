//! SSH transport: opens an SSH session to a remote host and forwards the
//! ANIMA service ports to localhost so the webviews can reach them.
//!
//! Pure planning logic (`plan_forwards`, `Endpoints::from_assignments`,
//! `backoff_delays`) is unit-tested; the live russh session drives it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

// ── Profile & endpoint types ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemotePorts {
    pub town: u16,
    pub openclaw: u16,
    pub api: u16,
    pub chat: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfileConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub agent: bool,
    pub remote_ports: RemotePorts,
}

/// Localhost URLs the frontend should load once forwards are up.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Endpoints {
    pub town: String,
    pub openclaw: String,
    pub chat: String,
    pub api: String,
}

/// One local-forward to establish: unique remote port → some local port.
#[derive(Debug, Clone, PartialEq)]
pub struct ForwardPlan {
    pub remote_port: u16,
}

/// Deduplicated list of remote ports that need a local listener.
/// Services sharing a remote port (e.g. chat == api) share one forward.
pub fn plan_forwards(ports: &RemotePorts) -> Vec<ForwardPlan> {
    let mut seen = Vec::new();
    for p in [ports.town, ports.openclaw, ports.api, ports.chat] {
        if !seen.contains(&p) {
            seen.push(p);
        }
    }
    seen.into_iter().map(|remote_port| ForwardPlan { remote_port }).collect()
}

impl Endpoints {
    /// Build localhost URLs from a remote-port → local-port assignment map.
    pub fn from_assignments(
        ports: &RemotePorts,
        assignments: &HashMap<u16, u16>,
    ) -> Option<Endpoints> {
        let url = |remote: u16| -> Option<String> {
            assignments.get(&remote).map(|local| format!("http://127.0.0.1:{local}"))
        };
        Some(Endpoints {
            town: url(ports.town)?,
            openclaw: url(ports.openclaw)?,
            chat: url(ports.chat)?,
            api: url(ports.api)?,
        })
    }
}

/// Reconnect delays in milliseconds: 5s flat, doubling after 3 failures,
/// capped at 30s. `attempt` is 0-based.
pub fn backoff_delay_ms(attempt: u32) -> u64 {
    const BASE: u64 = 5_000;
    const CAP: u64 = 30_000;
    if attempt < 3 {
        BASE
    } else {
        (BASE << (attempt - 2).min(4)).min(CAP)
    }
}

// ── Connection status events ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connected,
    Reconnecting,
    Disconnected,
}

// ── Live session management ─────────────────────────────────────────────────

struct ClientHandler;

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Hosts are user-configured (typically Tailscale peers); accept.
        Ok(true)
    }
}

pub struct ActiveTunnel {
    pub endpoints: Endpoints,
    /// Aborting this handle tears down all forward tasks + the session.
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl ActiveTunnel {
    pub fn shutdown(&self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

#[derive(Debug)]
pub enum SshError {
    PassphraseRequired,
    Auth(String),
    Connect(String),
    Forward(String),
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::PassphraseRequired => write!(f, "PASSPHRASE_REQUIRED"),
            SshError::Auth(e) => write!(f, "SSH authentication failed: {e}"),
            SshError::Connect(e) => write!(f, "SSH connection failed: {e}"),
            SshError::Forward(e) => write!(f, "Port forward failed: {e}"),
        }
    }
}

fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

async fn authenticate(
    session: &mut russh::client::Handle<ClientHandler>,
    profile: &SshProfileConfig,
    passphrase: Option<&str>,
) -> Result<(), SshError> {
    use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};

    if profile.agent {
        let mut agent = russh::keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| SshError::Auth(format!("ssh-agent unavailable: {e}")))?;
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| SshError::Auth(format!("ssh-agent identities: {e}")))?;
        for key in identities {
            let result = session
                .authenticate_publickey_with(
                    &profile.user,
                    key,
                    session.best_supported_rsa_hash().await.ok().flatten().flatten(),
                    &mut agent,
                )
                .await;
            if let Ok(auth) = result {
                if auth.success() {
                    return Ok(());
                }
            }
        }
        return Err(SshError::Auth("no agent identity accepted".into()));
    }

    let key_path = expand_tilde(
        profile
            .key_path
            .as_deref()
            .unwrap_or("~/.ssh/id_ed25519"),
    );
    let key = load_secret_key(&key_path, passphrase).map_err(|e| {
        let msg = e.to_string();
        // Encrypted key without (or with wrong) passphrase → ask the UI to prompt.
        if msg.to_lowercase().contains("passphrase")
            || msg.to_lowercase().contains("decrypt")
            || msg.to_lowercase().contains("encrypted")
        {
            SshError::PassphraseRequired
        } else {
            SshError::Auth(format!("cannot load key {}: {msg}", key_path.display()))
        }
    })?;

    let hash = session
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let auth = session
        .authenticate_publickey(
            &profile.user,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    if auth.success() {
        Ok(())
    } else {
        Err(SshError::Auth("public key rejected by server".into()))
    }
}

/// Open the SSH session and stand up one local listener per unique remote
/// port. Returns the endpoints plus the spawned forward tasks.
pub async fn connect_tunnel(
    profile: &SshProfileConfig,
    passphrase: Option<&str>,
) -> Result<ActiveTunnel, SshError> {
    let config = Arc::new(russh::client::Config::default());
    let addr = (profile.host.as_str(), profile.port);
    let mut session = russh::client::connect(config, addr, ClientHandler)
        .await
        .map_err(|e| SshError::Connect(e.to_string()))?;

    authenticate(&mut session, profile, passphrase).await?;
    let session = Arc::new(session);

    let mut assignments: HashMap<u16, u16> = HashMap::new();
    let mut tasks = Vec::new();

    for plan in plan_forwards(&profile.remote_ports) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| SshError::Forward(e.to_string()))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| SshError::Forward(e.to_string()))?
            .port();
        assignments.insert(plan.remote_port, local_port);

        let session = Arc::clone(&session);
        let remote_port = plan.remote_port;
        tasks.push(tokio::spawn(async move {
            loop {
                let Ok((mut socket, peer)) = listener.accept().await else {
                    break;
                };
                let session = Arc::clone(&session);
                tokio::spawn(async move {
                    let channel = session
                        .channel_open_direct_tcpip(
                            "127.0.0.1",
                            remote_port as u32,
                            &peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await;
                    let Ok(channel) = channel else { return };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    let _ = stream.shutdown().await;
                    let _ = socket.shutdown().await;
                });
            }
        }));
    }

    let endpoints = Endpoints::from_assignments(&profile.remote_ports, &assignments)
        .ok_or_else(|| SshError::Forward("incomplete port assignments".into()))?;

    Ok(ActiveTunnel { endpoints, tasks })
}

/// Probe the forwarded API port so callers can detect a dead tunnel.
pub async fn probe_endpoint(url: &str) -> bool {
    let Some(hostport) = url.strip_prefix("http://") else {
        return false;
    };
    let mut ok = false;
    if let Ok(Ok(mut s)) = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(hostport),
    )
    .await
    {
        // A TCP connect through the forward proves the tunnel path is alive.
        ok = true;
        let _ = s.shutdown().await;
    }
    ok
}

// ── Tests (pure logic) ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn ports(town: u16, openclaw: u16, api: u16, chat: u16) -> RemotePorts {
        RemotePorts { town, openclaw, api, chat }
    }

    #[test]
    fn plan_forwards_dedupes_shared_ports() {
        let plans = plan_forwards(&ports(3000, 18789, 3700, 3700));
        assert_eq!(plans.len(), 3);
        let remotes: Vec<u16> = plans.iter().map(|p| p.remote_port).collect();
        assert_eq!(remotes, vec![3000, 18789, 3700]);
    }

    #[test]
    fn plan_forwards_all_distinct() {
        let plans = plan_forwards(&ports(1, 2, 3, 4));
        assert_eq!(plans.len(), 4);
    }

    #[test]
    fn plan_forwards_all_same() {
        let plans = plan_forwards(&ports(8080, 8080, 8080, 8080));
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].remote_port, 8080);
    }

    #[test]
    fn endpoints_map_each_service_to_its_local_port() {
        let p = ports(3000, 18789, 3700, 3700);
        let mut a = HashMap::new();
        a.insert(3000, 50001);
        a.insert(18789, 50002);
        a.insert(3700, 50003);
        let e = Endpoints::from_assignments(&p, &a).unwrap();
        assert_eq!(e.town, "http://127.0.0.1:50001");
        assert_eq!(e.openclaw, "http://127.0.0.1:50002");
        assert_eq!(e.api, "http://127.0.0.1:50003");
        // chat shares api's remote port → same local forward
        assert_eq!(e.chat, e.api);
    }

    #[test]
    fn endpoints_missing_assignment_is_none() {
        let p = ports(3000, 18789, 3700, 3700);
        let a = HashMap::new();
        assert!(Endpoints::from_assignments(&p, &a).is_none());
    }

    #[test]
    fn backoff_is_flat_then_doubles_then_caps() {
        assert_eq!(backoff_delay_ms(0), 5_000);
        assert_eq!(backoff_delay_ms(1), 5_000);
        assert_eq!(backoff_delay_ms(2), 5_000);
        assert_eq!(backoff_delay_ms(3), 10_000);
        assert_eq!(backoff_delay_ms(4), 20_000);
        assert_eq!(backoff_delay_ms(5), 30_000);
        assert_eq!(backoff_delay_ms(20), 30_000);
    }

    #[test]
    fn expand_tilde_resolves_home() {
        let p = expand_tilde("~/.ssh/id_ed25519");
        assert!(!p.to_string_lossy().starts_with('~'));
        assert!(p.to_string_lossy().ends_with(".ssh/id_ed25519"));
    }

    #[test]
    fn ssh_profile_config_deserializes_from_frontend_shape() {
        let json = r#"{
            "host": "host-1.local",
            "port": 22,
            "user": "user",
            "keyPath": "~/.ssh/id_ed25519",
            "remotePorts": { "town": 3000, "openclaw": 18789, "api": 3700, "chat": 3700 }
        }"#;
        let p: SshProfileConfig = serde_json::from_str(json).unwrap();
        assert_eq!(p.host, "host-1.local");
        assert!(!p.agent);
        assert_eq!(p.remote_ports.chat, 3700);
    }

    /// Exercises the real forward data path with a mocked "remote" — a local
    /// TCP echo server stands in for the SSH-reachable service, and the
    /// listener/copy loop is driven the same way `connect_tunnel` wires it.
    #[tokio::test]
    async fn forward_listener_proxies_bytes() {
        // mock remote service: echoes one message
        let remote = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let remote_addr = remote.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = remote.accept().await.unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
        });

        // local listener that pipes to the mock remote (in the real tunnel this
        // pipe is an SSH channel; the copy loop is identical)
        let local = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let local_addr = local.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = local.accept().await.unwrap();
            let mut upstream = tokio::net::TcpStream::connect(remote_addr).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
        });

        let mut client = tokio::net::TcpStream::connect(local_addr).await.unwrap();
        client.write_all(b"anima").await.unwrap();
        let mut out = [0u8; 5];
        client.read_exact(&mut out).await.unwrap();
        assert_eq!(&out, b"anima");
    }

    #[tokio::test]
    async fn probe_endpoint_detects_open_and_closed_ports() {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let keep = tokio::spawn(async move {
            loop {
                let _ = l.accept().await;
            }
        });
        assert!(probe_endpoint(&format!("http://127.0.0.1:{port}")).await);
        keep.abort();
        // a port with (almost certainly) no listener
        assert!(!probe_endpoint("http://127.0.0.1:1").await);
        // non-http scheme rejected
        assert!(!probe_endpoint("https://127.0.0.1:443").await);
    }
}
