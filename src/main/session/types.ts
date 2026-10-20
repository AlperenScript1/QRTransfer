import { SessionState, DeviceInfo } from '../../shared/types';

export interface SessionConfig {
  waitingTtlMs?: number; // default: 10 mins (600_000)
  approvalTtlMs?: number; // default: 60 secs (60_000)
  idleTtlMs?: number; // default: 10 mins (600_000)
  absoluteTtlMs?: number; // default: 60 mins (3_600_000)
  maxFailedAttempts?: number; // default: 5
}

export interface Session {
  id: string;
  token: string;
  state: SessionState;
  createdAt: number;
  waitingExpiresAt: number;
  approvalExpiresAt?: number;
  lastActivityAt: number;
  absoluteExpiresAt: number;
  connectedDeviceId?: string;
  deviceInfo?: DeviceInfo;
  failedAttempts: number;
  webRtcOffer?: string;
  webRtcAnswer?: string;
  desktopIceCandidates: string[];
  mobileIceCandidates: string[];
}

export type SessionEvent =
  | { type: 'stateChanged'; state: SessionState }
  | { type: 'devicePendingApproval'; deviceInfo: DeviceInfo }
  | { type: 'secondDeviceAttempt'; deviceInfo: DeviceInfo }
  | { type: 'expired'; reason: string }
  | { type: 'bruteForceDetected' };
