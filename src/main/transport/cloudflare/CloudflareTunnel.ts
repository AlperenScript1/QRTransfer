import { Tunnel } from 'cloudflared';

const START_TIMEOUT_MS = 20_000;

export interface PublicTunnel {
  start(localUrl: string): Promise<string>;
  stop(): void;
}

interface TunnelProcess {
  on(event: 'error', listener: (error: Error) => void): TunnelProcess;
  once(event: 'url', listener: (url: string) => void): TunnelProcess;
  once(event: 'error', listener: (error: Error) => void): TunnelProcess;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): TunnelProcess;
  off(event: 'url', listener: (url: string) => void): TunnelProcess;
  off(event: 'error', listener: (error: Error) => void): TunnelProcess;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): TunnelProcess;
  stop(): boolean;
}

type TunnelFactory = (localUrl: string, originHost: string) => TunnelProcess;

/**
 * A short-lived, account-free HTTPS tunnel. The public URL changes for every
 * session and the process is stopped along with the HTTP server.
 */
export class CloudflareTunnel implements PublicTunnel {
  private tunnel: TunnelProcess | null = null;

  public constructor(
    private readonly createTunnel: TunnelFactory = (localUrl, originHost) =>
      Tunnel.quick(localUrl, {
        '--http-host-header': originHost,
        '--no-autoupdate': true
      })
  ) {}

  public async start(localUrl: string): Promise<string> {
    if (this.tunnel) {
      throw new Error('Tünel zaten çalışıyor');
    }

    const originHost = new URL(localUrl).host;
    const tunnel = this.createTunnel(localUrl, originHost);
    this.tunnel = tunnel;
    // A process may report an error while it is being intentionally stopped.
    // Keep an error listener attached so that this normal shutdown cannot turn
    // into an unhandled EventEmitter error in Electron.
    tunnel.on('error', () => undefined);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        tunnel.off('url', onUrl);
        tunnel.off('error', onError);
        tunnel.off('exit', onExit);
        callback();
      };
      const onUrl = (url: string): void => finish(() => resolve(url));
      const onError = (error: Error): void => finish(() => reject(error));
      const onExit = (): void => finish(() => reject(new Error('HTTPS tüneli başlatılamadı')));
      const timeout = setTimeout(() => {
        finish(() => reject(new Error('HTTPS tüneli zaman aşımına uğradı')));
      }, START_TIMEOUT_MS);

      tunnel.once('url', onUrl);
      tunnel.once('error', onError);
      tunnel.once('exit', onExit);
    });
  }

  public stop(): void {
    this.tunnel?.stop();
    this.tunnel = null;
  }
}
