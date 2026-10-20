import crypto from 'crypto';
import { EventEmitter } from 'events';
import { Session, SessionConfig, SessionEvent } from './types';
import { DeviceInfo } from '../../shared/types';

export class SessionManager extends EventEmitter {
  private static readonly maxIceCandidates = 64;
  private currentSession: Session | null = null;
  private readonly config: Required<SessionConfig>;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(config?: SessionConfig) {
    super();
    this.config = {
      waitingTtlMs: config?.waitingTtlMs ?? 10 * 60 * 1000, // 10 mins
      approvalTtlMs: config?.approvalTtlMs ?? 60 * 1000, // 60 secs
      idleTtlMs: config?.idleTtlMs ?? 10 * 60 * 1000, // 10 mins
      absoluteTtlMs: config?.absoluteTtlMs ?? 60 * 60 * 1000, // 60 mins
      maxFailedAttempts: config?.maxFailedAttempts ?? 5
    };
  }

  public getSession(): Session | null {
    if (this.currentSession) {
      this.checkExpiration();
    }
    return this.currentSession;
  }

  public createSession(): Session {
    if (this.currentSession && this.currentSession.state !== 'closed') {
      this.closeSession();
    }

    // Token: 128-bit random -> base64url (22 chars)
    const token = crypto.randomBytes(16).toString('base64url');
    const now = Date.now();

    this.currentSession = {
      id: crypto.randomUUID(),
      token,
      state: 'waiting',
      createdAt: now,
      waitingExpiresAt: now + this.config.waitingTtlMs,
      lastActivityAt: now,
      absoluteExpiresAt: now + this.config.absoluteTtlMs,
      failedAttempts: 0,
      desktopIceCandidates: [],
      mobileIceCandidates: []
    };

    this.emitEvent({ type: 'stateChanged', state: 'waiting' });
    this.startTimer();

    return this.currentSession;
  }

  /**
   * Constant-time comparison to prevent timing attacks.
   */
  public verifyToken(inputToken?: string): boolean {
    if (!this.currentSession || !inputToken) {
      this.recordFailedAttempt();
      return false;
    }

    this.checkExpiration();
    if (this.currentSession.state === 'closed' || this.currentSession.state === 'expired') {
      this.recordFailedAttempt();
      return false;
    }

    const sessionTokenBuf = Buffer.from(this.currentSession.token, 'utf8');
    const inputTokenBuf = Buffer.from(inputToken, 'utf8');

    let isValid = false;
    if (sessionTokenBuf.length === inputTokenBuf.length) {
      isValid = crypto.timingSafeEqual(sessionTokenBuf, inputTokenBuf);
    } else {
      // Dummy compare to avoid timing leak on length difference
      crypto.timingSafeEqual(sessionTokenBuf, sessionTokenBuf);
      isValid = false;
    }

    if (!isValid) {
      this.recordFailedAttempt();
      return false;
    }

    return true;
  }

  /**
   * First valid GET on /s/:token by a mobile device.
   * Assigns deviceId cookie and transitions state to pending_approval.
   */
  public handleInitialDeviceConnect(
    token: string,
    deviceInfo: DeviceInfo
  ): { success: boolean; deviceId?: string; error?: string } {
    if (!this.verifyToken(token)) {
      return { success: false, error: 'invalid_token' };
    }

    if (!this.currentSession) {
      return { success: false, error: 'invalid_token' };
    }

    if (this.currentSession.state === 'waiting') {
      // Generate 128-bit random deviceId
      const deviceId = crypto.randomBytes(16).toString('base64url');
      const now = Date.now();

      this.currentSession.connectedDeviceId = deviceId;
      this.currentSession.deviceInfo = deviceInfo;
      this.currentSession.state = 'pending_approval';
      this.currentSession.approvalExpiresAt = now + this.config.approvalTtlMs;
      this.currentSession.lastActivityAt = now;

      this.emitEvent({ type: 'stateChanged', state: 'pending_approval' });
      this.emitEvent({ type: 'devicePendingApproval', deviceInfo });

      return { success: true, deviceId };
    }

    // Another device attempting to connect
    this.emitEvent({ type: 'secondDeviceAttempt', deviceInfo });
    return { success: false, error: 'device_mismatch' };
  }

  /**
   * Desktop user approves or denies pairing request.
   */
  public respondPairing(approved: boolean): boolean {
    if (!this.currentSession || this.currentSession.state !== 'pending_approval') {
      return false;
    }

    if (approved) {
      this.currentSession.state = 'active';
      this.currentSession.lastActivityAt = Date.now();
      this.emitEvent({ type: 'stateChanged', state: 'active' });
      return true;
    } else {
      this.currentSession.state = 'closed';
      this.emitEvent({ type: 'stateChanged', state: 'closed' });
      this.stopTimer();
      return true;
    }
  }

  /**
   * Validates device cookie and token for status/upload requests.
   */
  public verifyDeviceRequest(
    token: string,
    deviceId?: string
  ): { ok: boolean; status: number; error: string } {
    if (!this.verifyToken(token)) {
      return { ok: false, status: 404, error: 'invalid_token' };
    }

    if (!this.currentSession) {
      return { ok: false, status: 404, error: 'invalid_token' };
    }

    if (!deviceId) {
      return { ok: false, status: 403, error: 'device_mismatch' };
    }

    if (
      !this.currentSession.connectedDeviceId ||
      !this.constantTimeEqual(this.currentSession.connectedDeviceId, deviceId)
    ) {
      this.recordFailedAttempt();
      this.emitEvent({
        type: 'secondDeviceAttempt',
        deviceInfo: { ip: 'unknown' }
      });
      return { ok: false, status: 403, error: 'device_mismatch' };
    }

    if (this.currentSession.state !== 'active') {
      return { ok: false, status: 403, error: 'not_active' };
    }

    this.currentSession.lastActivityAt = Date.now();
    return { ok: true, status: 200, error: '' };
  }

  public touchActivity(): void {
    if (this.currentSession && this.currentSession.state === 'active') {
      this.currentSession.lastActivityAt = Date.now();
    }
  }

  public setWebRtcOffer(offer: string): void {
    if (this.currentSession?.state === 'active') this.currentSession.webRtcOffer = offer;
  }

  public getWebRtcOffer(): string | undefined {
    return this.currentSession?.webRtcOffer;
  }

  public setWebRtcAnswer(answer: string): void {
    if (this.currentSession?.state === 'active') this.currentSession.webRtcAnswer = answer;
  }

  public takeWebRtcAnswer(): string | undefined {
    const answer = this.currentSession?.webRtcAnswer;
    if (this.currentSession) this.currentSession.webRtcAnswer = undefined;
    return answer;
  }

  public addDesktopIceCandidate(candidate: string): void {
    if (this.currentSession?.state === 'active' && this.currentSession.desktopIceCandidates.length < SessionManager.maxIceCandidates) {
      this.currentSession.desktopIceCandidates.push(candidate);
    }
  }

  public takeDesktopIceCandidates(): string[] {
    if (!this.currentSession) return [];
    return this.currentSession.desktopIceCandidates.splice(0);
  }

  public addMobileIceCandidate(candidate: string): void {
    if (this.currentSession?.state === 'active' && this.currentSession.mobileIceCandidates.length < SessionManager.maxIceCandidates) {
      this.currentSession.mobileIceCandidates.push(candidate);
    }
  }

  public takeMobileIceCandidates(): string[] {
    if (!this.currentSession) return [];
    return this.currentSession.mobileIceCandidates.splice(0);
  }

  public closeSession(): void {
    if (this.currentSession && this.currentSession.state !== 'closed') {
      this.currentSession.state = 'closed';
      this.emitEvent({ type: 'stateChanged', state: 'closed' });
    }
    this.stopTimer();
  }

  private recordFailedAttempt(): void {
    if (!this.currentSession) return;

    this.currentSession.failedAttempts++;
    if (this.currentSession.failedAttempts >= this.config.maxFailedAttempts) {
      this.emitEvent({ type: 'bruteForceDetected' });
      this.closeSession();
    }
  }

  public checkExpiration(): void {
    if (!this.currentSession || this.currentSession.state === 'closed' || this.currentSession.state === 'expired') {
      return;
    }

    const now = Date.now();

    // Absolute timeout
    if (now >= this.currentSession.absoluteExpiresAt) {
      this.expire('absolute_timeout');
      return;
    }

    // Waiting timeout
    if (this.currentSession.state === 'waiting' && now >= this.currentSession.waitingExpiresAt) {
      this.expire('waiting_timeout');
      return;
    }

    // Approval timeout
    if (
      this.currentSession.state === 'pending_approval' &&
      this.currentSession.approvalExpiresAt &&
      now >= this.currentSession.approvalExpiresAt
    ) {
      this.expire('approval_timeout');
      return;
    }

    // Idle timeout
    if (
      this.currentSession.state === 'active' &&
      now - this.currentSession.lastActivityAt >= this.config.idleTtlMs
    ) {
      this.expire('idle_timeout');
      return;
    }
  }

  private expire(reason: string): void {
    if (this.currentSession) {
      this.currentSession.state = 'expired';
      this.emitEvent({ type: 'expired', reason });
      this.emitEvent({ type: 'stateChanged', state: 'expired' });
      this.closeSession();
    }
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private startTimer(): void {
    this.stopTimer();
    this.checkTimer = setInterval(() => {
      this.checkExpiration();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private emitEvent(event: SessionEvent): void {
    this.emit(event.type, event);
    this.emit('event', event);
  }
}
