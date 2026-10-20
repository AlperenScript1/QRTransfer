import os from 'os';
import { NetworkInterfaceCandidate } from '../../shared/types';

// Virtual interface name keywords
const VIRTUAL_NAME_REGEX =
  /(docker|vbox|virtualbox|vmnet|vmware|wsl|vethernet|hyper-v|tun|tap|utun|tailscale|zerotier|wireguard|npcap)/i;

// Known virtual adapter MAC prefixes (OUI)
const VIRTUAL_MAC_PREFIXES = [
  '00:05:69', // VMware
  '00:0c:29', // VMware
  '00:50:56', // VMware
  '08:00:27', // VirtualBox
  '00:15:5d', // Hyper-V
  '02:42', // Docker
  '00:00:00:00:00:00' // Null MAC / tunnels
];

const WIFI_NAME_REGEX = /(wi-fi|wifi|wlan|wireless)/i;
const ETHERNET_NAME_REGEX = /(ethernet|eth|en[0-9]|lan)/i;

export function isVirtualAdapter(name: string, mac: string): boolean {
  if (VIRTUAL_NAME_REGEX.test(name)) {
    return true;
  }

  const normalizedMac = mac.toLowerCase();
  for (const prefix of VIRTUAL_MAC_PREFIXES) {
    if (normalizedMac.startsWith(prefix.toLowerCase())) {
      return true;
    }
  }

  return false;
}

export function calculatePriority(name: string, isVirtual: boolean): number {
  if (isVirtual) {
    return 10;
  }
  if (WIFI_NAME_REGEX.test(name)) {
    return 1;
  }
  if (ETHERNET_NAME_REGEX.test(name)) {
    return 2;
  }
  return 3;
}

export function getNetworkCandidates(
  interfacesDict?: NodeJS.Dict<os.NetworkInterfaceInfo[]>
): NetworkInterfaceCandidate[] {
  const ifaces = interfacesDict ?? os.networkInterfaces();
  const candidates: NetworkInterfaceCandidate[] = [];

  for (const [name, infoList] of Object.entries(ifaces)) {
    if (!name || !infoList) continue;

    for (const info of infoList) {
      // Must be IPv4, non-internal
      if (info.family !== 'IPv4' || info.internal) {
        continue;
      }

      // Ignore link-local (169.254.x.x) and invalid 0.0.0.0
      if (info.address.startsWith('169.254.') || info.address === '0.0.0.0') {
        continue;
      }

      const isVirtual = isVirtualAdapter(name, info.mac);
      const priority = calculatePriority(name, isVirtual);

      candidates.push({
        name,
        address: info.address,
        netmask: info.netmask,
        family: 'IPv4',
        mac: info.mac,
        isVirtual,
        priority
      });
    }
  }

  // Sort by priority (lowest number first), then by name
  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.name.localeCompare(b.name);
  });
}

export function selectDefaultInterface(
  candidates: NetworkInterfaceCandidate[]
): NetworkInterfaceCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  // If there are non-virtual candidates, select the top one
  const nonVirtual = candidates.filter((c) => !c.isVirtual);
  if (nonVirtual.length > 0) {
    return nonVirtual[0];
  }
  return candidates[0];
}
