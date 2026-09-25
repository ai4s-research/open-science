// The operating system's proxy setting, reduced to what a sidecar can take.
//
// Every consumer downstream — OpenCode (Bun), agent-browser, uv — receives the
// proxy as HTTP(S)_PROXY / NO_PROXY environment variables, which hold ONE proxy
// for every destination. So whatever the OS describes (per-protocol servers, a
// PAC script, a bypass list) is resolved here to one HTTP proxy URL plus the
// bypass entries NO_PROXY can express.
//
// Only HTTP proxies are ever returned. Measured with the Bun inside the bundled
// OpenCode (1.3.14): `HTTPS_PROXY=socks5://…` does not fall back — every fetch
// fails with `UnsupportedProxyProtocol` — and `ALL_PROXY` is not read at all. A
// SOCKS-only system setting therefore resolves to "no proxy detected" rather
// than to a value that would break every request.
//
//   macOS    `scutil --proxy` (manual HTTP/HTTPS proxies; PAC is not evaluated)
//   Windows  WinHTTP's view of the user's settings — manual proxy, bypass list,
//            and PAC (`AutoConfigURL`, what v2rayN's PAC mode writes)
//   Linux    nothing is read; a terminal launch already carries the user's env

/// The OS proxy as one HTTP proxy URL plus the hosts that must bypass it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemProxy {
    pub url: String,
    /// NO_PROXY-ready entries (bare or dot-prefixed domain suffixes, hosts, IPs).
    pub bypass: Vec<String>,
}

pub fn detect() -> Option<SystemProxy> {
    platform::detect()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{parse_scutil_proxy, SystemProxy};

    pub fn detect() -> Option<SystemProxy> {
        let out = crate::runtime::quiet_command("scutil")
            .arg("--proxy")
            .output()
            .ok()?;
        let url = parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout))?;
        Some(SystemProxy {
            url,
            bypass: Vec::new(),
        })
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn detect() -> Option<super::SystemProxy> {
        None
    }
}

/// Parse `scutil --proxy` output (`  Key : value` lines) into a proxy URL.
/// HTTPS is preferred over HTTP; an HTTPS proxy endpoint still speaks plain
/// HTTP CONNECT, hence the http:// scheme either way. Compiled where it is
/// reachable plus tests everywhere, so it stays covered on any host.
#[cfg(any(target_os = "macos", test))]
fn parse_scutil_proxy(text: &str) -> Option<String> {
    let get = |key: &str| -> Option<String> {
        let prefix = format!("{key} : ");
        text.lines().find_map(|l| {
            l.trim()
                .strip_prefix(prefix.as_str())
                .map(|v| v.trim().to_string())
        })
    };
    let enabled = |key: &str| get(key).as_deref() == Some("1");
    for (en, host, port) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort"),
    ] {
        if enabled(en) {
            if let (Some(h), Some(p)) = (get(host), get(port)) {
                return Some(format!("http://{h}:{p}"));
            }
        }
    }
    None
}

/// Parse a WinINet/WinHTTP proxy string into one HTTP proxy URL.
///
/// Two shapes exist: one server for every protocol (`127.0.0.1:7890`), or a
/// per-protocol list (`http=h:p;https=h:p;socks=h:p`). WinHTTP's PAC results use
/// the first shape, possibly as a `;`/space-separated list of fallbacks. The
/// proxy for https destinations wins, then http, then an unlabelled server;
/// `socks=` (and any other protocol) is skipped because no consumer can use it.
#[cfg(any(windows, test))]
fn parse_windows_proxy_server(value: &str) -> Option<String> {
    let mut https = None;
    let mut http = None;
    let mut plain = None;
    for entry in value
        .split(|c: char| c == ';' || c.is_whitespace())
        .filter(|e| !e.is_empty())
    {
        let (slot, server) = match entry.split_once('=') {
            Some((proto, server)) => match proto.to_ascii_lowercase().as_str() {
                "https" => (&mut https, server),
                "http" => (&mut http, server),
                _ => continue,
            },
            None => (&mut plain, entry),
        };
        if slot.is_none() {
            *slot = http_proxy_url(server);
        }
    }
    https.or(http).or(plain)
}

/// `host:port` or `http(s)://host:port` → `http(s)://host:port`; anything
/// naming another scheme (socks…) → None.
#[cfg(any(windows, test))]
fn http_proxy_url(server: &str) -> Option<String> {
    let server = server.trim().trim_end_matches('/');
    if server.is_empty() {
        return None;
    }
    match server.split_once("://") {
        Some((scheme, rest)) if !rest.is_empty() => {
            let scheme = scheme.to_ascii_lowercase();
            (scheme == "http" || scheme == "https").then(|| format!("{scheme}://{rest}"))
        }
        Some(_) => None,
        None => Some(format!("http://{server}")),
    }
}

/// Windows' bypass list (`ProxyOverride`) → the entries NO_PROXY can express.
///
/// Bun matches NO_PROXY entries only as exact hosts or domain suffixes
/// (`corp.com` and `.corp.com` both cover `www.corp.com`); measured, it ignores
/// any entry containing `*`. So `*.corp.com` becomes `.corp.com`, other
/// wildcards (`10.*`, `192.168.*`) are dropped — they cannot be said — and
/// `<local>` is dropped because loopback is always bypassed anyway.
#[cfg(any(windows, test))]
fn windows_bypass_to_no_proxy(value: &str) -> Vec<String> {
    value
        .split(|c: char| c == ';' || c == ',' || c.is_whitespace())
        .filter(|e| !e.is_empty() && !e.eq_ignore_ascii_case("<local>"))
        .filter_map(|e| {
            let e = e
                .strip_prefix("*.")
                .map(|rest| format!(".{rest}"))
                .unwrap_or_else(|| e.to_string());
            (!e.contains('*')).then_some(e)
        })
        .collect()
}

#[cfg(windows)]
mod platform {
    use super::{parse_windows_proxy_server, windows_bypass_to_no_proxy, SystemProxy};
    use std::ptr::null;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl,
        WinHttpOpen, WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_NAMED_PROXY,
        WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS,
        WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO,
    };

    /// Destinations a PAC script is asked about. The sidecar's traffic is
    /// overwhelmingly the model providers' APIs, and a PAC script that routes
    /// those through a proxy is exactly the case this exists for; the first
    /// one it sends to a proxy decides.
    const PAC_PROBE_URLS: [&str; 2] = ["https://api.openai.com/", "https://api.anthropic.com/"];

    /// The order WinHTTP/Chromium apply: a PAC script, when configured and
    /// evaluable, decides (including "DIRECT"); otherwise the manual proxy.
    /// WPAD auto-detection is not attempted — it searches the network and can
    /// stall for seconds, and it belongs to managed corporate networks.
    pub fn detect() -> Option<SystemProxy> {
        let config = UserProxyConfig::read()?;
        let bypass = config
            .proxy_bypass
            .as_deref()
            .map(windows_bypass_to_no_proxy)
            .unwrap_or_default();
        if let Some(pac_url) = config.auto_config_url.as_deref() {
            match evaluate_pac(pac_url) {
                Some(PacAnswer::Proxy(url)) => return Some(SystemProxy { url, bypass }),
                Some(PacAnswer::Direct) => return None,
                None => {} // not evaluable: fall back to the manual proxy
            }
        }
        let url = parse_windows_proxy_server(config.proxy.as_deref()?)?;
        Some(SystemProxy { url, bypass })
    }

    /// `WINHTTP_CURRENT_USER_IE_PROXY_CONFIG`, copied out and freed.
    struct UserProxyConfig {
        auto_config_url: Option<String>,
        proxy: Option<String>,
        proxy_bypass: Option<String>,
    }

    impl UserProxyConfig {
        fn read() -> Option<Self> {
            let mut raw = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
            // SAFETY: `raw` is a valid out-pointer; on success the three strings
            // are GlobalAlloc'd (or null) and ours to free, which take_wide does.
            let ok = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut raw) } != 0;
            let config = UserProxyConfig {
                auto_config_url: unsafe { take_wide(raw.lpszAutoConfigUrl) },
                proxy: unsafe { take_wide(raw.lpszProxy) },
                proxy_bypass: unsafe { take_wide(raw.lpszProxyBypass) },
            };
            ok.then_some(config)
        }
    }

    enum PacAnswer {
        /// The script sends a probe through this proxy.
        Proxy(String),
        /// The script answers DIRECT for every probe.
        Direct,
    }

    /// None = the script could not be evaluated (unreachable, invalid).
    fn evaluate_pac(pac_url: &str) -> Option<PacAnswer> {
        let agent = wide("Open Science");
        // SAFETY: plain WinHTTP session calls; every handle opened is closed below.
        let session = unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                null(),
                null(),
                0,
            )
        };
        if session.is_null() {
            return None;
        }
        // The PAC script is usually served from localhost by the proxy client
        // itself; bound every phase so a dead PAC server cannot stall a caller.
        unsafe { WinHttpSetTimeouts(session, 2000, 2000, 2000, 2000) };
        let pac = wide(pac_url);
        let mut evaluated = false;
        let mut answer = PacAnswer::Direct;
        for probe in PAC_PROBE_URLS {
            let mut options = WINHTTP_AUTOPROXY_OPTIONS {
                dwFlags: WINHTTP_AUTOPROXY_CONFIG_URL,
                lpszAutoConfigUrl: pac.as_ptr(),
                ..Default::default()
            };
            let mut info = WINHTTP_PROXY_INFO::default();
            let probe = wide(probe);
            // SAFETY: valid session, NUL-terminated inputs, out-struct whose
            // strings are GlobalAlloc'd (or null) and freed by take_wide.
            let ok =
                unsafe { WinHttpGetProxyForUrl(session, probe.as_ptr(), &mut options, &mut info) }
                    != 0;
            let proxy = unsafe { take_wide(info.lpszProxy) };
            unsafe { take_wide(info.lpszProxyBypass) };
            if !ok {
                continue;
            }
            evaluated = true;
            if info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY {
                if let Some(url) = proxy.as_deref().and_then(parse_windows_proxy_server) {
                    answer = PacAnswer::Proxy(url);
                    break;
                }
            }
        }
        unsafe { WinHttpCloseHandle(session) };
        evaluated.then_some(answer)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Copy a GlobalAlloc'd, NUL-terminated UTF-16 string and free it.
    /// SAFETY: `p` is null or a GlobalAlloc'd NUL-terminated wide string that
    /// nothing else frees.
    unsafe fn take_wide(p: *mut u16) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
        GlobalFree(p.cast());
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the REAL system proxy and compares it with what the caller set up
    /// (`OSD_EXPECT_SYSTEM_PROXY`: the URL, or empty for "none detected").
    /// Ignored because it depends on machine state; run it by hand after
    /// setting the proxy the way a client like Clash does:
    ///   OSD_EXPECT_SYSTEM_PROXY=http://127.0.0.1:7890 \
    ///     cargo test -p osd-core live_system_proxy -- --ignored
    #[test]
    #[ignore]
    fn live_system_proxy_matches_expectation() {
        let expected =
            std::env::var("OSD_EXPECT_SYSTEM_PROXY").expect("set OSD_EXPECT_SYSTEM_PROXY");
        let got = detect();
        eprintln!("detected: {got:?}");
        let (url, bypass) = got.map(|p| (p.url, p.bypass.join(","))).unwrap_or_default();
        assert_eq!(url, expected);
        if let Ok(expected_bypass) = std::env::var("OSD_EXPECT_SYSTEM_PROXY_BYPASS") {
            assert_eq!(bypass, expected_bypass);
        }
    }

    #[test]
    fn scutil_prefers_https_and_never_returns_socks() {
        // Real `scutil --proxy` shape (indented `Key : value` lines).
        let all = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 1087\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 1087\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n  SOCKSPort : 1087\n  SOCKSProxy : 127.0.0.1\n}";
        assert_eq!(
            parse_scutil_proxy(all).as_deref(),
            Some("http://127.0.0.1:1087")
        );
        let socks_only = "  SOCKSEnable : 1\n  SOCKSPort : 7890\n  SOCKSProxy : 10.0.0.2\n";
        assert_eq!(parse_scutil_proxy(socks_only), None);
        let disabled = "  HTTPEnable : 0\n  HTTPPort : 1087\n  HTTPProxy : 127.0.0.1\n";
        assert_eq!(parse_scutil_proxy(disabled), None);
        assert_eq!(parse_scutil_proxy(""), None);
    }

    #[test]
    fn windows_proxy_server_shapes() {
        // One server for all protocols — what Clash for Windows / Clash Verge write.
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        // Per-protocol: the https destination's proxy wins, whatever the order.
        assert_eq!(
            parse_windows_proxy_server("ftp=f:21;http=h:80;https=s:443;socks=k:1080").as_deref(),
            Some("http://s:443")
        );
        assert_eq!(
            parse_windows_proxy_server("http=h:8080;socks=k:1080").as_deref(),
            Some("http://h:8080")
        );
        // SOCKS only: nothing a consumer can use.
        assert_eq!(parse_windows_proxy_server("socks=127.0.0.1:1080"), None);
        assert_eq!(parse_windows_proxy_server("socks5://127.0.0.1:1080"), None);
        // An explicit scheme is kept; a trailing slash is not.
        assert_eq!(
            parse_windows_proxy_server("http://127.0.0.1:7890/").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server("HTTPS=HTTPS://p:1").as_deref(),
            Some("https://p:1")
        );
        // PAC results: a fallback list — the first usable entry.
        assert_eq!(
            parse_windows_proxy_server("a:1; b:2").as_deref(),
            Some("http://a:1")
        );
        assert_eq!(parse_windows_proxy_server(""), None);
        assert_eq!(parse_windows_proxy_server(" ; "), None);
    }

    #[test]
    fn windows_bypass_keeps_only_what_no_proxy_can_say() {
        // Clash's default override list: only the plain host survives.
        let clash = "localhost;127.*;10.*;172.16.*;192.168.*;<local>";
        assert_eq!(windows_bypass_to_no_proxy(clash), vec!["localhost"]);
        assert_eq!(
            windows_bypass_to_no_proxy("*.corp.example; intranet ;10.0.0.5;*abc*"),
            vec![".corp.example", "intranet", "10.0.0.5"]
        );
        assert!(windows_bypass_to_no_proxy("").is_empty());
    }
}
