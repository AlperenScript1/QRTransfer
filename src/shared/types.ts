export type SessionState = 'idle' | 'waiting' | 'pending_approval' | 'active' | 'closed' | 'expired';

export interface DeviceInfo {
  ip: string;
  userAgent?: string;
}

export interface ReceivedFile {
  id: string;
  name: string;
  size: number;
  path: string;
  receivedAt: number;
}

export interface OutgoingFile {
  id: string;
  name: string;
  size: number;
  path: string;
}

export interface NetworkInterfaceCandidate {
  name: string;
  address: string;
  netmask: string;
  family: 'IPv4';
  mac: string;
  isVirtual: boolean;
  priority: number; // lower number = higher priority (1: Wi-Fi/Ethernet, 10: Virtual)
}
