import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../src/main/session/SessionManager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SessionManager({
      waitingTtlMs: 10 * 60 * 1000, // 10m
      approvalTtlMs: 60 * 1000, // 60s
      idleTtlMs: 10 * 60 * 1000, // 10m
      absoluteTtlMs: 60 * 60 * 1000, // 60m
      maxFailedAttempts: 5
    });
  });

  afterEach(() => {
    manager.closeSession();
    vi.useRealTimers();
  });

  it('should create a session with 128-bit base64url token (22 chars) in waiting state', () => {
    const session = manager.createSession();

    expect(session.token).toHaveLength(22);
    expect(session.state).toBe('waiting');
    expect(session.failedAttempts).toBe(0);
    expect(session.connectedDeviceId).toBeUndefined();
  });

  it('should verify token with constant time and reject invalid tokens', () => {
    const session = manager.createSession();

    expect(manager.verifyToken(session.token)).toBe(true);
    expect(manager.verifyToken('invalid-token')).toBe(false);
    expect(manager.verifyToken('')).toBe(false);
    expect(manager.verifyToken('short')).toBe(false);
  });

  it('should close session after 5 failed token attempts (brute-force protection)', () => {
    const bruteForceSpy = vi.fn();
    manager.on('bruteForceDetected', bruteForceSpy);

    manager.createSession();

    for (let i = 0; i < 4; i++) {
      expect(manager.verifyToken('wrong-token-attempt')).toBe(false);
      expect(manager.getSession()?.state).toBe('waiting');
    }

    // 5th attempt triggers close
    expect(manager.verifyToken('wrong-token-attempt')).toBe(false);
    expect(bruteForceSpy).toHaveBeenCalledTimes(1);
    expect(manager.getSession()?.state).toBe('closed');
  });

  it('should transition to pending_approval on first device connect and assign deviceId', () => {
    const session = manager.createSession();
    const connectResult = manager.handleInitialDeviceConnect(session.token, {
      ip: '192.168.1.150',
      userAgent: 'Mozilla/5.0 (iPhone)'
    });

    expect(connectResult.success).toBe(true);
    expect(connectResult.deviceId).toBeDefined();
    expect(connectResult.deviceId).toHaveLength(22);
    expect(manager.getSession()?.state).toBe('pending_approval');
    expect(manager.getSession()?.deviceInfo?.ip).toBe('192.168.1.150');
  });

  it('should reject a second device trying to connect to the same session', () => {
    const secondDeviceSpy = vi.fn();
    manager.on('secondDeviceAttempt', secondDeviceSpy);

    const session = manager.createSession();
    manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });

    // Second device attempts connection
    const secondResult = manager.handleInitialDeviceConnect(session.token, {
      ip: '192.168.1.200'
    });

    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toBe('device_mismatch');
    expect(secondDeviceSpy).toHaveBeenCalledTimes(1);
  });

  it('should handle desktop approval and transition to active state', () => {
    const session = manager.createSession();
    const connect = manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });

    const approved = manager.respondPairing(true);
    expect(approved).toBe(true);
    expect(manager.getSession()?.state).toBe('active');

    // Verification of active device
    const check = manager.verifyDeviceRequest(session.token, connect.deviceId);
    expect(check.ok).toBe(true);
    expect(check.status).toBe(200);
  });

  it('should close session if desktop denies pairing', () => {
    const session = manager.createSession();
    manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });

    const denied = manager.respondPairing(false);
    expect(denied).toBe(true);
    expect(manager.getSession()?.state).toBe('closed');
  });

  it('should reject requests with wrong deviceId or when not active', () => {
    const session = manager.createSession();
    const connect = manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });

    // In pending_approval (not yet active)
    const pendingCheck = manager.verifyDeviceRequest(session.token, connect.deviceId);
    expect(pendingCheck.ok).toBe(false);
    expect(pendingCheck.error).toBe('not_active');

    manager.respondPairing(true);

    // Active, but wrong deviceId
    const wrongDeviceCheck = manager.verifyDeviceRequest(session.token, 'wrong-device-id-cookie');
    expect(wrongDeviceCheck.ok).toBe(false);
    expect(wrongDeviceCheck.error).toBe('device_mismatch');
  });

  it('should expire if waiting TTL (10m) is exceeded without device connection', () => {
    manager.createSession();
    expect(manager.getSession()?.state).toBe('waiting');

    // Advance 9 mins (still waiting)
    vi.advanceTimersByTime(9 * 60 * 1000);
    manager.checkExpiration();
    expect(manager.getSession()?.state).toBe('waiting');

    // Advance past 10 mins
    vi.advanceTimersByTime(2 * 60 * 1000);
    manager.checkExpiration();
    expect(manager.getSession()?.state).toBe('closed');
  });

  it('should expire if approval TTL (60s) is exceeded without desktop approval', () => {
    const session = manager.createSession();
    manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });
    expect(manager.getSession()?.state).toBe('pending_approval');

    // Advance 61 seconds
    vi.advanceTimersByTime(61 * 1000);
    manager.checkExpiration();
    expect(manager.getSession()?.state).toBe('closed');
  });

  it('should expire if active session stays idle past idle TTL (10m)', () => {
    const session = manager.createSession();
    manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });
    manager.respondPairing(true);
    expect(manager.getSession()?.state).toBe('active');

    // Advance 11 minutes without activity
    vi.advanceTimersByTime(11 * 60 * 1000);
    manager.checkExpiration();
    expect(manager.getSession()?.state).toBe('closed');
  });

  it('should reset idle timer when activity occurs', () => {
    const session = manager.createSession();
    manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });
    manager.respondPairing(true);

    // 8 mins pass
    vi.advanceTimersByTime(8 * 60 * 1000);
    manager.touchActivity(); // Activity recorded

    // Another 8 mins pass (16m total, but only 8m since last activity)
    vi.advanceTimersByTime(8 * 60 * 1000);
    manager.checkExpiration();
    expect(manager.getSession()?.state).toBe('active');
  });

  it('should expire when absolute TTL (60m) is reached regardless of activity', () => {
    const session = manager.createSession();
    manager.handleInitialDeviceConnect(session.token, { ip: '192.168.1.150' });
    manager.respondPairing(true);

    // Simulate constant activity every 5 mins for 61 mins
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      manager.touchActivity();
    }
    vi.advanceTimersByTime(2 * 60 * 1000); // 62 mins total
    manager.checkExpiration();

    expect(manager.getSession()?.state).toBe('closed');
  });

  it('should reject invalid state transitions', () => {
    manager.createSession();
    // Cannot approve when state is waiting
    expect(manager.respondPairing(true)).toBe(false);

    manager.closeSession();
    // Cannot approve when closed
    expect(manager.respondPairing(true)).toBe(false);
  });
});
