import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'os';
import {
  getNetworkCandidates,
  isVirtualAdapter,
  calculatePriority,
  selectDefaultInterface
} from '../src/main/network/networkInfo';

describe('networkInfo', () => {
  describe('isVirtualAdapter', () => {
    it('should identify virtual adapters by name', () => {
      expect(isVirtualAdapter('docker0', '00:11:22:33:44:55')).toBe(true);
      expect(isVirtualAdapter('vboxnet0', '00:11:22:33:44:55')).toBe(true);
      expect(isVirtualAdapter('vEthernet (WSL)', '00:11:22:33:44:55')).toBe(true);
      expect(isVirtualAdapter('VMware Network Adapter VMnet1', '00:11:22:33:44:55')).toBe(true);
      expect(isVirtualAdapter('utun2', '00:11:22:33:44:55')).toBe(true);
      expect(isVirtualAdapter('tailscale0', '00:11:22:33:44:55')).toBe(true);
    });

    it('should identify virtual adapters by MAC prefix', () => {
      expect(isVirtualAdapter('Local Area Connection', '08:00:27:12:34:56')).toBe(true); // VirtualBox
      expect(isVirtualAdapter('Ethernet 2', '00:05:69:aa:bb:cc')).toBe(true); // VMware
      expect(isVirtualAdapter('Network Adapter', '00:15:5d:01:02:03')).toBe(true); // Hyper-V
      expect(isVirtualAdapter('Dummy', '00:00:00:00:00:00')).toBe(true);
    });

    it('should not mark real physical adapters as virtual', () => {
      expect(isVirtualAdapter('Wi-Fi', 'b4:2e:99:11:22:33')).toBe(false);
      expect(isVirtualAdapter('Ethernet', '3c:7c:3f:aa:bb:cc')).toBe(false);
      expect(isVirtualAdapter('en0', 'ac:de:48:00:11:22')).toBe(false);
      expect(isVirtualAdapter('wlan0', '18:56:80:44:55:66')).toBe(false);
    });
  });

  describe('calculatePriority', () => {
    it('should give highest priority (1) to Wi-Fi', () => {
      expect(calculatePriority('Wi-Fi', false)).toBe(1);
      expect(calculatePriority('wlan0', false)).toBe(1);
      expect(calculatePriority('Wireless Network Connection', false)).toBe(1);
    });

    it('should give priority 2 to Ethernet', () => {
      expect(calculatePriority('Ethernet', false)).toBe(2);
      expect(calculatePriority('eth0', false)).toBe(2);
      expect(calculatePriority('en0', false)).toBe(2);
    });

    it('should give lowest priority (10) to virtual adapters', () => {
      expect(calculatePriority('vEthernet (WSL)', true)).toBe(10);
      expect(calculatePriority('Wi-Fi Virtual Adapter', true)).toBe(10);
    });
  });

  describe('getNetworkCandidates', () => {
    const mockInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8'
        }
      ],
      'Wi-Fi': [
        {
          address: '192.168.1.105',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'b4:2e:99:11:22:33',
          internal: false,
          cidr: '192.168.1.105/24'
        },
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: 'b4:2e:99:11:22:33',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 1
        }
      ],
      Ethernet: [
        {
          address: '192.168.1.50',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '3c:7c:3f:aa:bb:cc',
          internal: false,
          cidr: '192.168.1.50/24'
        }
      ],
      'vEthernet (WSL)': [
        {
          address: '172.28.16.1',
          netmask: '255.255.240.0',
          family: 'IPv4',
          mac: '00:15:5d:45:67:89',
          internal: false,
          cidr: '172.28.16.1/20'
        }
      ],
      'VirtualBox Host-Only Network': [
        {
          address: '192.168.56.1',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '0a:00:27:00:00:00',
          internal: false,
          cidr: '192.168.56.1/24'
        }
      ],
      'Link-Local Interface': [
        {
          address: '169.254.10.20',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '12:34:56:78:90:ab',
          internal: false,
          cidr: '169.254.10.20/16'
        }
      ]
    };

    it('should filter out internal, IPv6 and link-local addresses', () => {
      const candidates = getNetworkCandidates(mockInterfaces);
      const addresses = candidates.map((c) => c.address);

      expect(addresses).not.toContain('127.0.0.1');
      expect(addresses).not.toContain('fe80::1');
      expect(addresses).not.toContain('169.254.10.20');
      expect(candidates.length).toBe(4);
    });

    it('should sort candidates by priority (Wi-Fi first, then Ethernet, then Virtual)', () => {
      const candidates = getNetworkCandidates(mockInterfaces);

      expect(candidates[0].name).toBe('Wi-Fi');
      expect(candidates[0].priority).toBe(1);
      expect(candidates[0].isVirtual).toBe(false);

      expect(candidates[1].name).toBe('Ethernet');
      expect(candidates[1].priority).toBe(2);
      expect(candidates[1].isVirtual).toBe(false);

      expect(candidates[2].isVirtual).toBe(true);
      expect(candidates[3].isVirtual).toBe(true);
    });

    it('should correctly select default interface', () => {
      const candidates = getNetworkCandidates(mockInterfaces);
      const defaultIf = selectDefaultInterface(candidates);

      expect(defaultIf).not.toBeNull();
      expect(defaultIf?.name).toBe('Wi-Fi');
      expect(defaultIf?.address).toBe('192.168.1.105');
    });

    it('should fallback to virtual if no physical adapter exists', () => {
      const virtualOnlyMock: NodeJS.Dict<NetworkInterfaceInfo[]> = {
        docker0: [
          {
            address: '172.17.0.1',
            netmask: '255.255.0.0',
            family: 'IPv4',
            mac: '02:42:11:22:33:44',
            internal: false,
            cidr: '172.17.0.1/16'
          }
        ]
      };
      const candidates = getNetworkCandidates(virtualOnlyMock);
      expect(candidates.length).toBe(1);
      expect(candidates[0].isVirtual).toBe(true);

      const defaultIf = selectDefaultInterface(candidates);
      expect(defaultIf?.name).toBe('docker0');
    });

    it('should return null when no candidates are available', () => {
      expect(selectDefaultInterface([])).toBeNull();
    });
  });
});
