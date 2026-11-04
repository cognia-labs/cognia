//! Where a request to a host listener came from: the one answer every
//! loopback privilege reads.
//!
//! cloudflared connects to the same listener from loopback, so a socket peer
//! of `127.0.0.1` does not mean the caller sits on this machine. Every route
//! that grants something to loopback callers (operator endpoints, service
//! tokens, fleet hooks, single-user Owner invitations, the pre-auth rate-limit
//! exemption) asks [`request_origin`] instead of reading the peer itself.
//!
//! The listener matters as much as the peer. A VS Code dev-tunnel forward
//! (ADR-0235) also connects from `127.0.0.1` and sets no Cloudflare header, so
//! the Host serves it on a dedicated ingress listener whose requests carry
//! [`ListenerKind::TunnelIngress`]. Nothing a client sends can change which
//! listener accepted its connection.
//!
//! A reverse proxy in front of the Host (the Compose deployment's Caddy) is
//! another peer: every request it forwards arrives from its own address, so
//! all its clients would share one pre-auth rate-limit bucket. The operator
//! names such proxies in `COGNIA_TRUSTED_PROXIES`; from those peers alone the
//! right-most `X-Forwarded-For` entry, the address the proxy itself saw, is the
//! client. Anyone else's forwarding headers are ignored.

use std::net::{IpAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::RwLock;

// `reqwest` re-exports the `http` crate's `HeaderMap`, the same type axum
// hands its handlers, so this crate needs no direct `http` dependency.
use reqwest::header::HeaderMap;

/// Which kind of listener accepted the connection.
///
/// Listeners insert it as a request extension. A router served without one
/// (unit tests over `Router::oneshot`) reads as [`ListenerKind::Local`], the
/// classification every pre-ADR-0235 listener had; the tunnel ingress listener
/// always inserts [`ListenerKind::TunnelIngress`] itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ListenerKind {
    /// The HTTPS companion listener or the plaintext loopback browser
    /// listener: a loopback peer without tunnel headers is on this machine.
    #[default]
    Local,
    /// The loopback-bound listener a tunnel forward targets. Every request on
    /// it came from the public internet, whatever its peer or headers.
    TunnelIngress,
}

/// Request provenance shared by loopback gates and pre-auth rate limiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestOrigin {
    /// The socket peer is loopback and no tunnel marked the request.
    pub direct_loopback: bool,
    /// The address to rate-limit by: the tunnel's visitor address when the
    /// local proxy supplied exactly one valid one, otherwise the peer.
    pub client_ip: Option<IpAddr>,
}

/// Classify a request from its listener, socket peer and headers. A missing
/// peer is never loopback, so a privilege cannot be reached without a verified
/// one, and a tunnel ingress request is never direct loopback.
pub fn request_origin(
    listener: ListenerKind,
    peer: Option<IpAddr>,
    headers: &HeaderMap,
) -> RequestOrigin {
    classify(listener, peer, headers, &|ip| TRUSTED_PROXIES.contains(ip))
}

fn classify(
    listener: ListenerKind,
    peer: Option<IpAddr>,
    headers: &HeaderMap,
    trusted_proxy: &dyn Fn(IpAddr) -> bool,
) -> RequestOrigin {
    let peer = peer.map(|ip| ip.to_canonical());
    if listener == ListenerKind::TunnelIngress {
        // The forward's own connection is the peer. A visitor's request can
        // carry any header through the tunnel, including `cf-connecting-ip`,
        // so none of them may pick the rate-limit bucket: every ingress
        // visitor shares the peer's bucket until the tunnel's own forwarding
        // header is measured (ADR-0235 spike S1).
        return RequestOrigin {
            direct_loopback: false,
            client_ip: peer,
        };
    }
    // A trusted proxy's forwarded request is its client's, never a local one.
    // Without a valid entry it stays in the proxy's own bucket.
    if let Some(proxy) = peer.filter(|ip| trusted_proxy(*ip)) {
        if headers.contains_key("x-forwarded-for") {
            return RequestOrigin {
                direct_loopback: false,
                client_ip: Some(forwarded_client(headers).unwrap_or(proxy)),
            };
        }
    }
    let peer_is_loopback = peer.is_some_and(|ip| ip.is_loopback());
    // cloudflared connects to the same HTTPS listener from loopback. Header
    // presence removes local privileges even when the value is empty, invalid,
    // or itself loopback. CF-Ray also covers a removed visitor-IP header.
    let via_cloudflare = headers.contains_key("cf-connecting-ip") || headers.contains_key("cf-ray");
    // Only the local proxy may supply the rate-limit identity. A LAN client
    // must not rotate buckets by spoofing forwarding headers. Missing or
    // ambiguous IPs fall back to the peer bucket, never to an exemption.
    let forwarded_ip = if peer_is_loopback {
        let mut values = headers.get_all("cf-connecting-ip").iter();
        let ip = values
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<IpAddr>().ok());
        ip.filter(|_| values.next().is_none())
            .map(|ip| ip.to_canonical())
    } else {
        None
    };
    RequestOrigin {
        direct_loopback: peer_is_loopback && !via_cloudflare,
        client_ip: forwarded_ip.or(peer),
    }
}

/// The right-most `X-Forwarded-For` entry: the address the nearest proxy
/// connected from. Entries further left were supplied by that client.
fn forwarded_client(headers: &HeaderMap) -> Option<IpAddr> {
    let last = headers.get_all("x-forwarded-for").iter().last()?.to_str().ok()?;
    let entry = last.rsplit(',').next()?.trim();
    entry.parse::<IpAddr>().ok().map(|ip| ip.to_canonical())
}

/// One `COGNIA_TRUSTED_PROXIES` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProxyEntry {
    /// An address, or a network as `address/prefix`.
    Net(IpAddr, u8),
    /// A name resolved in the background (a Compose service such as `caddy`).
    Host(String),
}

fn parse_entry(raw: &str) -> Option<ProxyEntry> {
    let (address, prefix) = match raw.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix.parse::<u8>().ok()?)),
        None => (raw, None),
    };
    if let Ok(ip) = address.parse::<IpAddr>() {
        let ip = ip.to_canonical();
        let width = if ip.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(width);
        return (prefix <= width).then_some(ProxyEntry::Net(ip, prefix));
    }
    let hostname = prefix.is_none()
        && !raw.is_empty()
        && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
    hostname.then(|| ProxyEntry::Host(raw.to_ascii_lowercase()))
}

fn in_net(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    match (ip.to_canonical(), net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(net) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
            u128::from(ip) & mask == u128::from(net) & mask
        }
        _ => false,
    }
}

/// The proxies `COGNIA_TRUSTED_PROXIES` names, with each hostname's current
/// addresses. Empty unless the operator set it.
struct TrustedProxies {
    entries: Vec<ProxyEntry>,
    resolved: Arc<RwLock<Vec<IpAddr>>>,
}

/// How often hostname entries are re-resolved: a restarted proxy container
/// comes back on a new address.
const RESOLVE_EVERY: Duration = Duration::from_secs(30);

impl TrustedProxies {
    fn parse(raw: &str) -> Self {
        let mut entries = Vec::new();
        for item in raw.split([',', ' ', '\n', '\t']).filter(|item| !item.is_empty()) {
            match parse_entry(item) {
                Some(entry) => entries.push(entry),
                None => log::warn!("COGNIA_TRUSTED_PROXIES: ignoring invalid entry {item:?}"),
            }
        }
        Self { entries, resolved: Arc::default() }
    }

    fn from_env() -> Self {
        let proxies = Self::parse(&std::env::var("COGNIA_TRUSTED_PROXIES").unwrap_or_default());
        let hosts: Vec<String> = proxies
            .entries
            .iter()
            .filter_map(|entry| match entry {
                ProxyEntry::Host(host) => Some(host.clone()),
                ProxyEntry::Net(..) => None,
            })
            .collect();
        if !hosts.is_empty() {
            let resolved = Arc::clone(&proxies.resolved);
            // Blocking lookups, kept off the request path and the async runtime.
            let spawned = std::thread::Builder::new()
                .name("trusted-proxy-resolver".into())
                .spawn(move || {
                    let mut known = HostAddresses::default();
                    loop {
                        *resolved.write() = known.refresh(&hosts, |host| {
                            (host, 0).to_socket_addrs().map(|found| found.map(|a| a.ip()).collect())
                        });
                        std::thread::sleep(RESOLVE_EVERY);
                    }
                });
            if let Err(error) = spawned {
                log::warn!("COGNIA_TRUSTED_PROXIES: hostname resolver did not start: {error}");
            }
        }
        proxies
    }

    fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.entries.iter().any(|entry| matches!(entry, ProxyEntry::Net(net, prefix) if in_net(ip, *net, *prefix)))
            || self.resolved.read().contains(&ip)
    }
}

/// Each trusted hostname's last good addresses.
#[derive(Default)]
struct HostAddresses {
    last: std::collections::HashMap<String, Vec<IpAddr>>,
    /// Hosts already warned about, so a proxy that is not deployed (no `tls`
    /// profile) is reported once, not every interval.
    unresolved: std::collections::HashSet<String>,
}

impl HostAddresses {
    /// Resolve every host once. A host that fails keeps its last addresses: a
    /// restarting proxy container must not drop its clients into its bucket.
    fn refresh(
        &mut self,
        hosts: &[String],
        resolve: impl Fn(&str) -> std::io::Result<Vec<IpAddr>>,
    ) -> Vec<IpAddr> {
        for host in hosts {
            match resolve(host) {
                Ok(found) => {
                    self.unresolved.remove(host);
                    self.last.insert(host.clone(), found.into_iter().map(|ip| ip.to_canonical()).collect());
                }
                Err(error) => {
                    if self.unresolved.insert(host.clone()) {
                        log::warn!("COGNIA_TRUSTED_PROXIES: cannot resolve {host}: {error}");
                    }
                }
            }
        }
        self.last.values().flatten().copied().collect()
    }
}

static TRUSTED_PROXIES: Lazy<TrustedProxies> = Lazy::new(TrustedProxies::from_env);

/// Read `COGNIA_TRUSTED_PROXIES` and start resolving its hostnames now, so the
/// first proxied requests already carry their client's address.
pub fn init_trusted_proxies() {
    Lazy::force(&TRUSTED_PROXIES);
}

/// Whether a request may use a loopback-only privilege: its peer is loopback
/// and it did not arrive through a tunnel.
pub fn is_direct_loopback(
    listener: ListenerKind,
    peer: Option<IpAddr>,
    headers: &HeaderMap,
) -> bool {
    request_origin(listener, peer, headers).direct_loopback
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn a_plain_loopback_peer_is_direct() {
        let headers = HeaderMap::new();
        assert!(is_direct_loopback(
            ListenerKind::Local,
            Some("127.0.0.1".parse().unwrap()),
            &headers
        ));
        assert!(is_direct_loopback(
            ListenerKind::Local,
            Some("::1".parse().unwrap()),
            &headers
        ));
        // An IPv4-mapped loopback is loopback once canonicalized.
        assert!(is_direct_loopback(
            ListenerKind::Local,
            Some("::ffff:127.0.0.1".parse().unwrap()),
            &headers
        ));
    }

    #[test]
    fn a_lan_peer_or_an_unknown_peer_is_not_direct() {
        let headers = HeaderMap::new();
        assert!(!is_direct_loopback(
            ListenerKind::Local,
            Some("192.168.1.20".parse().unwrap()),
            &headers
        ));
        assert!(!is_direct_loopback(ListenerKind::Local, None, &headers));
    }

    #[test]
    fn any_tunnel_header_removes_loopback_even_when_empty_or_loopback() {
        let peer = Some("127.0.0.1".parse().unwrap());
        for (name, value) in [
            ("cf-ray", "test-ray-SJC"),
            ("cf-connecting-ip", ""),
            ("cf-connecting-ip", "127.0.0.1"),
            ("cf-connecting-ip", "not an address"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(name, HeaderValue::from_static(value));
            assert!(
                !is_direct_loopback(ListenerKind::Local, peer, &headers),
                "{name}: {value:?} kept loopback"
            );
        }
    }

    #[test]
    fn cloudflare_origin_rejects_ambiguous_ips_and_canonicalizes_addresses() {
        let peer = Some("127.0.0.1".parse().unwrap());
        for values in [
            vec![HeaderValue::from_static("198.51.100.1, 198.51.100.2")],
            vec![HeaderValue::from_bytes(&[0xff]).unwrap()],
            vec![
                HeaderValue::from_static("198.51.100.1"),
                HeaderValue::from_static("198.51.100.2"),
            ],
        ] {
            let mut headers = HeaderMap::new();
            for value in values {
                headers.append("cf-connecting-ip", value);
            }
            let origin = request_origin(ListenerKind::Local, peer, &headers);
            assert!(!origin.direct_loopback);
            assert_eq!(origin.client_ip, peer);
        }

        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "::ffff:198.51.100.1".parse().unwrap());
        let origin = request_origin(ListenerKind::Local, peer, &headers);
        assert!(!origin.direct_loopback);
        assert_eq!(origin.client_ip, Some("198.51.100.1".parse().unwrap()));
        let unknown = request_origin(ListenerKind::Local, None, &headers);
        assert!(!unknown.direct_loopback);
        assert_eq!(unknown.client_ip, None);
    }

    #[test]
    fn a_lan_peer_cannot_choose_its_rate_limit_bucket() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        let peer: IpAddr = "192.168.1.20".parse().unwrap();
        assert_eq!(
            request_origin(ListenerKind::Local, Some(peer), &headers).client_ip,
            Some(peer)
        );
    }
    #[test]
    fn tunnel_ingress_is_never_direct_loopback_for_any_peer_or_headers() {
        let peers: [Option<IpAddr>; 5] = [
            Some("127.0.0.1".parse().unwrap()),
            Some("::1".parse().unwrap()),
            Some("::ffff:127.0.0.1".parse().unwrap()),
            Some("192.168.1.20".parse().unwrap()),
            None,
        ];
        let header_sets: [&[(&str, &str)]; 3] = [
            &[],
            &[("cf-connecting-ip", "198.51.100.7")],
            &[
                ("cf-ray", "test-ray-SJC"),
                ("cf-connecting-ip", "127.0.0.1"),
            ],
        ];
        for peer in peers {
            for set in header_sets {
                let mut headers = HeaderMap::new();
                for (name, value) in set {
                    headers.insert(*name, HeaderValue::from_static(value));
                }
                assert!(
                    !is_direct_loopback(ListenerKind::TunnelIngress, peer, &headers),
                    "{peer:?} with {set:?} reached loopback through tunnel ingress"
                );
            }
        }
    }

    #[test]
    fn tunnel_ingress_visitors_cannot_choose_their_rate_limit_bucket() {
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        let origin = request_origin(ListenerKind::TunnelIngress, Some(peer), &headers);
        assert_eq!(origin.client_ip, Some(peer));
        // The same headers on a local listener are cloudflared's, and pick the
        // visitor's bucket as before.
        let local = request_origin(ListenerKind::Local, Some(peer), &headers);
        assert_eq!(local.client_ip, Some("198.51.100.7".parse().unwrap()));
        assert!(!local.direct_loopback);
        let unknown = request_origin(ListenerKind::TunnelIngress, None, &headers);
        assert_eq!(unknown.client_ip, None);
    }

    #[test]
    fn a_listener_without_a_tag_classifies_as_local() {
        assert_eq!(ListenerKind::default(), ListenerKind::Local);
    }

    fn forwarded(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append("x-forwarded-for", HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn a_trusted_proxy_hands_each_client_its_own_bucket() {
        let caddy: IpAddr = "172.18.0.5".parse().unwrap();
        let trusted = |ip: IpAddr| ip == caddy;
        let origin = |headers: &HeaderMap| classify(ListenerKind::Local, Some(caddy), headers, &trusted);
        // Caddy appends the address it saw; whatever the client sent sits left of it.
        let client = origin(&forwarded(&["10.9.9.9, 203.0.113.4"]));
        assert_eq!(client, RequestOrigin { direct_loopback: false, client_ip: Some("203.0.113.4".parse().unwrap()) });
        assert_eq!(origin(&forwarded(&["10.9.9.9", "198.51.100.8"])).client_ip, Some("198.51.100.8".parse().unwrap()));
        assert_eq!(origin(&forwarded(&["::ffff:198.51.100.9"])).client_ip, Some("198.51.100.9".parse().unwrap()));
        // An unreadable entry falls back to the proxy's bucket, never an exemption.
        assert_eq!(origin(&forwarded(&["203.0.113.4, not-an-ip"])).client_ip, Some(caddy));
        assert_eq!(origin(&HeaderMap::new()).client_ip, Some(caddy));
    }

    #[test]
    fn an_untrusted_peer_cannot_choose_its_bucket_with_forwarding_headers() {
        let lan: IpAddr = "192.168.1.20".parse().unwrap();
        let origin = classify(ListenerKind::Local, Some(lan), &forwarded(&["203.0.113.4"]), &|_| false);
        assert_eq!(origin.client_ip, Some(lan));
        // Nor a direct published-port client that happens to share the proxy's network.
        let neighbour: IpAddr = "172.18.0.1".parse().unwrap();
        let origin = classify(ListenerKind::Local, Some(neighbour), &forwarded(&["203.0.113.4"]),
            &|ip| ip == "172.18.0.5".parse::<IpAddr>().unwrap());
        assert_eq!(origin.client_ip, Some(neighbour));
    }

    #[test]
    fn a_forwarded_request_through_a_loopback_proxy_loses_loopback_privileges() {
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let trusted = |ip: IpAddr| ip.is_loopback();
        let proxied = classify(ListenerKind::Local, Some(loopback), &forwarded(&["203.0.113.4"]), &trusted);
        assert!(!proxied.direct_loopback);
        // The same proxy address without forwarding is a local caller.
        assert!(classify(ListenerKind::Local, Some(loopback), &HeaderMap::new(), &trusted).direct_loopback);
        // A tunnel ingress request stays in the forward's bucket whatever it carries.
        let tunnel = classify(ListenerKind::TunnelIngress, Some(loopback), &forwarded(&["203.0.113.4"]), &trusted);
        assert_eq!(tunnel.client_ip, Some(loopback));
    }

    #[test]
    fn trusted_proxy_entries_parse_addresses_networks_and_hostnames() {
        let proxies = TrustedProxies::parse("caddy, 10.0.0.0/8 2001:db8::/32\n192.0.2.7 bad/99 ex@mple /8");
        assert_eq!(proxies.entries, vec![
            ProxyEntry::Host("caddy".into()),
            ProxyEntry::Net("10.0.0.0".parse().unwrap(), 8),
            ProxyEntry::Net("2001:db8::".parse().unwrap(), 32),
            ProxyEntry::Net("192.0.2.7".parse().unwrap(), 32),
        ]);
        for inside in ["10.200.3.4", "::ffff:10.1.1.1", "2001:db8:1::5", "192.0.2.7"] {
            assert!(proxies.contains(inside.parse().unwrap()), "{inside}");
        }
        for outside in ["11.0.0.1", "192.0.2.8", "2001:db9::1"] {
            assert!(!proxies.contains(outside.parse().unwrap()), "{outside}");
        }
        // A hostname matches only the addresses it resolved to.
        assert!(!proxies.contains("172.18.0.5".parse().unwrap()));
        proxies.resolved.write().push("172.18.0.5".parse().unwrap());
        assert!(proxies.contains("172.18.0.5".parse().unwrap()));
        // `/0` is every address of that family, and nothing else.
        let everything = TrustedProxies::parse("0.0.0.0/0");
        assert!(everything.contains("198.51.100.1".parse().unwrap()));
        assert!(!everything.contains("2001:db8::1".parse().unwrap()));
        assert!(TrustedProxies::parse("").entries.is_empty());
    }

    #[test]
    fn a_proxy_hostname_that_stops_resolving_keeps_its_last_addresses() {
        let hosts = vec!["caddy".to_string(), "edge".to_string()];
        let mut known = HostAddresses::default();
        let first = known.refresh(&hosts, |host| match host {
            "caddy" => Ok(vec!["172.18.0.5".parse().unwrap()]),
            _ => Err(std::io::Error::other("not deployed")),
        });
        assert_eq!(first, vec!["172.18.0.5".parse::<IpAddr>().unwrap()]);
        // Caddy restarts: unresolvable for a moment, then back on a new address.
        let restarting = known.refresh(&hosts, |_| Err(std::io::Error::other("restarting")));
        assert_eq!(restarting, first);
        let moved = known.refresh(&hosts, |host| match host {
            "caddy" => Ok(vec!["::ffff:172.18.0.9".parse().unwrap()]),
            _ => Err(std::io::Error::other("not deployed")),
        });
        assert_eq!(moved, vec!["172.18.0.9".parse::<IpAddr>().unwrap()]);
        assert!(known.unresolved.contains("edge"));
        assert!(!known.unresolved.contains("caddy"));
    }
}
