use std::net::{IpAddr, Ipv4Addr, UdpSocket};

pub(crate) fn detect_lan_ip() -> anyhow::Result<IpAddr> {
    let routed = routed_ipv4();
    if let Some(ip) = routed.filter(Ipv4Addr::is_private) {
        return Ok(IpAddr::V4(ip));
    }

    let interfaces = if_addrs::get_if_addrs()?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) => Some((interface.name, ip)),
            IpAddr::V6(_) => None,
        })
        .collect::<Vec<_>>();
    if let Some(ip) = select_lan_ipv4(interfaces) {
        return Ok(IpAddr::V4(ip));
    }
    routed
        .filter(is_usable_ipv4)
        .map(IpAddr::V4)
        .ok_or_else(|| anyhow::anyhow!("failed to resolve a LAN-reachable local IPv4 address"))
}

fn routed_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if is_usable_ipv4(&ip) => Some(ip),
        _ => None,
    }
}

fn select_lan_ipv4(mut candidates: Vec<(String, Ipv4Addr)>) -> Option<Ipv4Addr> {
    candidates.retain(|(_, ip)| is_usable_ipv4(ip));
    candidates.sort_by_key(|(name, ip)| {
        let name = name.to_ascii_lowercase();
        let virtual_interface = [
            "vpn",
            "radmin",
            "tailscale",
            "zerotier",
            "wsl",
            "docker",
            "hyper-v",
            "vmware",
            "virtualbox",
            "vbox",
            "loopback",
        ]
        .iter()
        .any(|marker| name.contains(marker));
        (!ip.is_private(), virtual_interface, name)
    });
    candidates.into_iter().next().map(|(_, ip)| ip)
}

fn is_usable_ipv4(ip: &Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_link_local()
        && !ip.is_multicast()
        && *ip != Ipv4Addr::BROADCAST
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_private_physical_lan_over_vpn() {
        let selected = select_lan_ipv4(vec![
            ("Radmin VPN".to_string(), Ipv4Addr::new(26, 232, 20, 133)),
            ("Ethernet".to_string(), Ipv4Addr::new(192, 168, 15, 3)),
        ]);

        assert_eq!(selected, Some(Ipv4Addr::new(192, 168, 15, 3)));
    }

    #[test]
    fn rejects_loopback_and_link_local_candidates() {
        let selected = select_lan_ipv4(vec![
            ("Loopback".to_string(), Ipv4Addr::LOCALHOST),
            ("Disconnected".to_string(), Ipv4Addr::new(169, 254, 1, 20)),
        ]);

        assert_eq!(selected, None);
    }
}
