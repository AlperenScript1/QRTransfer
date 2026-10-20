import { Readable } from 'stream';

export interface FileMeta {
  originalName: string;
  expectedSize?: number;
}

export interface FileResult {
  fileName: string;
  size: number;
}

export interface Transport {
  start(connectUrl: string): Promise<void>;
  stop(): Promise<void>;
  onIncomingFile(handler: (meta: FileMeta, stream: Readable) => Promise<FileResult>): void;
}
