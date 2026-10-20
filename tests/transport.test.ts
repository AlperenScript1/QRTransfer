import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionManager } from '../src/main/session/SessionManager';
import { FileSink } from '../src/main/storage/FileSink';
import { HttpTransport } from '../src/main/transport/http/HttpTransport';

describe('HttpTransport (Görev 4)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let fileSink: FileSink;
  let transport: HttpTransport;
  let baseUrl: string;
  let token: string;
  let serverHost: string;
  let serverPort: number;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'http-transport-test-'));
    sessionManager = new SessionManager();
    fileSink = new FileSink({ downloadDir: tmpDir });
    serverHost = '127.0.0.1';

    transport = new HttpTransport({
      sessionManager,
      fileSink,
      host: serverHost,
      maxFileSizeBytes: 10 * 1024 * 1024 // 10MB
    });

    const { port, url } = await transport.start();
    serverPort = port;
    baseUrl = url;

    const s = sessionManager.createSession();
    token = s.token;
  });

  afterEach(async () => {
    await transport.stop();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects requests with mismatched Host header (DNS rebinding protection)', async () => {
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: serverHost,
          port: serverPort,
          path: `/s/${token}`,
          method: 'GET',
          headers: {
            Host: 'evil-attacker.com'
          }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(400);
  });

  it('sets required security headers on all responses', async () => {
    const res = await fetch(`${baseUrl}/s/${token}`, {
      headers: {
        host: `${serverHost}:${serverPort}`
      }
    });

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('returns 404 for invalid or non-existent token', async () => {
    const res = await fetch(`${baseUrl}/s/non-existent-token-123`, {
      headers: {
        host: `${serverHost}:${serverPort}`
      }
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('serves mobile HTML page and sets deviceId cookie on first connection', async () => {
    const res = await fetch(`${baseUrl}/s/${token}`, {
      headers: {
        host: `${serverHost}:${serverPort}`
      }
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('deviceId=');
    expect(setCookie).toContain('HttpOnly');

    const html = await res.text();
    expect(html).toContain('QRTransfer');

    // Session state should transition to pending_approval
    expect(sessionManager.getSession()?.state).toBe('pending_approval');
  });

  it('rejects second device attempting to connect to the same session', async () => {
    // First device connects
    const res1 = await fetch(`${baseUrl}/s/${token}`, {
      headers: { host: `${serverHost}:${serverPort}` }
    });
    expect(res1.status).toBe(200);

    // Second device without device cookie connects
    const res2 = await fetch(`${baseUrl}/s/${token}`, {
      headers: { host: `${serverHost}:${serverPort}` }
    });
    expect(res2.status).toBe(403);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toBe('device_mismatch');
  });

  it('checks status endpoint with valid device cookie', async () => {
    // 1. Initial connect
    const res1 = await fetch(`${baseUrl}/s/${token}`, {
      headers: { host: `${serverHost}:${serverPort}` }
    });
    const cookieHeader = res1.headers.get('set-cookie')?.split(';')[0] ?? '';

    // 2. Poll status (pending_approval)
    const statusRes1 = await fetch(`${baseUrl}/s/${token}/status`, {
      headers: {
        host: `${serverHost}:${serverPort}`,
        cookie: cookieHeader
      }
    });
    expect(statusRes1.status).toBe(200);
    const statusBody1 = (await statusRes1.json()) as { state: string };
    expect(statusBody1.state).toBe('pending_approval');

    // 3. Desktop approves pairing
    sessionManager.respondPairing(true);

    // 4. Poll status again (active)
    const statusRes2 = await fetch(`${baseUrl}/s/${token}/status`, {
      headers: {
        host: `${serverHost}:${serverPort}`,
        cookie: cookieHeader
      }
    });
    expect(statusRes2.status).toBe(200);
    const statusBody2 = (await statusRes2.json()) as { state: string };
    expect(statusBody2.state).toBe('active');
  });

  it('rejects uploads if session is not active', async () => {
    const res1 = await fetch(`${baseUrl}/s/${token}`, {
      headers: { host: `${serverHost}:${serverPort}` }
    });
    const cookieHeader = res1.headers.get('set-cookie')?.split(';')[0] ?? '';

    // Not approved yet (pending_approval)
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'hello.txt');

    const uploadRes = await fetch(`${baseUrl}/s/${token}/upload`, {
      method: 'POST',
      headers: {
        host: `${serverHost}:${serverPort}`,
        cookie: cookieHeader
      },
      body: form
    });

    expect(uploadRes.status).toBe(403);
    const body = (await uploadRes.json()) as { error: string };
    expect(body.error).toBe('not_active');
  });

  it('allows mobile device to cleanly close session', async () => {
    const res1 = await fetch(`${baseUrl}/s/${token}`, {
      headers: { host: `${serverHost}:${serverPort}` }
    });
    const cookieHeader = res1.headers.get('set-cookie')?.split(';')[0] ?? '';

    const closeRes = await fetch(`${baseUrl}/s/${token}/close`, {
      method: 'POST',
      headers: {
        host: `${serverHost}:${serverPort}`,
        cookie: cookieHeader
      }
    });

    expect(closeRes.status).toBe(204);
    expect(sessionManager.getSession()?.state).toBe('closed');
  });
});
