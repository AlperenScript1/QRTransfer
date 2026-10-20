import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { CloudflareTunnel } from '../src/main/transport/cloudflare/CloudflareTunnel';

class FakeTunnel extends EventEmitter {
  public readonly stop = vi.fn(() => true);
}

describe('CloudflareTunnel', () => {
  it('returns the public HTTPS URL and pins the origin Host header', async () => {
    const fakeTunnel = new FakeTunnel();
    const factory = vi.fn(() => fakeTunnel);
    const tunnel = new CloudflareTunnel(factory);

    const result = tunnel.start('http://127.0.0.1:4567');
    fakeTunnel.emit('url', 'https://example.trycloudflare.com');

    await expect(result).resolves.toBe('https://example.trycloudflare.com');
    expect(factory).toHaveBeenCalledWith('http://127.0.0.1:4567', '127.0.0.1:4567');
  });

  it('stops the tunnel when the session closes', async () => {
    const fakeTunnel = new FakeTunnel();
    const tunnel = new CloudflareTunnel(() => fakeTunnel);

    const started = tunnel.start('http://127.0.0.1:4567');
    fakeTunnel.emit('url', 'https://example.trycloudflare.com');
    await started;
    tunnel.stop();

    expect(fakeTunnel.stop).toHaveBeenCalledOnce();
  });
});
