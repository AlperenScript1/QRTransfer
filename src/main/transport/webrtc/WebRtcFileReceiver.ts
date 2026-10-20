import crypto from 'crypto';
import { once } from 'events';
import { PassThrough } from 'stream';
import { FileSink, SavedFileResult } from '../../storage/FileSink';

interface PendingFile {
  stream: PassThrough;
  result: Promise<SavedFileResult>;
}

export class WebRtcFileReceiver {
  private readonly pending = new Map<string, PendingFile>();

  public constructor(
    private readonly fileSink: FileSink,
    private readonly onComplete: (file: SavedFileResult) => void
  ) {}

  public start(originalName: string, expectedSize: number): string {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error('bad_request');
    const id = crypto.randomUUID();
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    const result = this.fileSink.saveFile({ originalName, expectedSize }, stream);
    this.pending.set(id, { stream, result });
    return id;
  }

  public async write(id: string, chunk: Uint8Array): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('invalid_transfer');
    if (!pending.stream.write(chunk)) await once(pending.stream, 'drain');
  }

  public async finish(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('invalid_transfer');
    this.pending.delete(id);
    pending.stream.end();
    const file = await pending.result;
    this.onComplete(file);
  }

  public abortAll(): void {
    for (const pending of this.pending.values()) {
      // The session is deliberately closing; consume the FileSink rejection so
      // Electron does not surface it as an unhandled error.
      void pending.result.catch(() => undefined);
      pending.stream.destroy(new Error('session_closed'));
    }
    this.pending.clear();
  }
}
