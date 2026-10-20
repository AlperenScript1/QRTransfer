import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { sanitizeFileName, resolveSafePath } from './sanitize';

export interface FileMeta {
  originalName: string;
  expectedSize?: number;
}

export interface FileSinkOptions {
  downloadDir: string;
  maxFileSizeBytes?: number; // default: 4 GB
}

export interface SavedFileResult {
  fileName: string;
  filePath: string;
  size: number;
}

export class FileSink {
  private readonly downloadDir: string;
  private readonly maxFileSizeBytes: number;

  constructor(options: FileSinkOptions) {
    this.downloadDir = path.resolve(options.downloadDir);
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 4 * 1024 * 1024 * 1024; // 4 GB
  }

  public async saveFile(meta: FileMeta, stream: Readable): Promise<SavedFileResult> {
    // Ensure download directory exists
    await fs.promises.mkdir(this.downloadDir, { recursive: true });

    // 1. Sanitize file name
    const sanitizedBase = sanitizeFileName(meta.originalName);

    // 2. Check disk space if expected size is known
    if (meta.expectedSize !== undefined && meta.expectedSize > 0) {
      if (meta.expectedSize > this.maxFileSizeBytes) {
        throw new Error('file_too_large');
      }
      const hasSpace = await this.hasEnoughDiskSpace(meta.expectedSize);
      if (!hasSpace) {
        throw new Error('insufficient_storage');
      }
    }

    // 3. Resolve conflicts (never overwrite, use "name (1).ext")
    const finalName = await this.resolveConflictName(sanitizedBase);
    const finalPath = resolveSafePath(this.downloadDir, finalName);
    const partPath = `${finalPath}.part`;

    let bytesWritten = 0;

    return new Promise<SavedFileResult>((resolve, reject) => {
      let isAborted = false;
      const writeStream = fs.createWriteStream(partPath, { flags: 'w' });

      const cleanupPartFile = async () => {
        try {
          if (fs.existsSync(partPath)) {
            await fs.promises.unlink(partPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      };

      const abort = async (err: Error) => {
        if (isAborted) return;
        isAborted = true;

        stream.destroy(err);
        writeStream.destroy();
        await cleanupPartFile();
        reject(err);
      };

      stream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > this.maxFileSizeBytes) {
          abort(new Error('file_too_large'));
        }
      });

      stream.on('error', (err) => {
        abort(err);
      });

      writeStream.on('error', (err) => {
        abort(err);
      });

      writeStream.on('finish', async () => {
        if (isAborted) return;

        try {
          // Verify size if expected size was provided
          if (meta.expectedSize !== undefined && meta.expectedSize !== bytesWritten) {
            await cleanupPartFile();
            reject(new Error('size_mismatch'));
            return;
          }

          // Atomic rename from .part to final
          await fs.promises.rename(partPath, finalPath);

          resolve({
            fileName: finalName,
            filePath: finalPath,
            size: bytesWritten
          });
        } catch (renameErr) {
          await cleanupPartFile();
          reject(renameErr);
        }
      });

      stream.pipe(writeStream);
    });
  }

  private async resolveConflictName(sanitizedName: string): Promise<string> {
    const extIndex = sanitizedName.lastIndexOf('.');
    const base = extIndex !== -1 ? sanitizedName.slice(0, extIndex) : sanitizedName;
    const ext = extIndex !== -1 ? sanitizedName.slice(extIndex) : '';

    let candidate = sanitizedName;
    let counter = 1;

    while (await this.fileExists(path.join(this.downloadDir, candidate))) {
      candidate = `${base} (${counter})${ext}`;
      counter++;
    }

    return candidate;
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async hasEnoughDiskSpace(requiredBytes: number): Promise<boolean> {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const stats = await fs.promises.statfs(this.downloadDir);
        const freeBytes = BigInt(stats.bfree) * BigInt(stats.bsize);
        return freeBytes >= BigInt(requiredBytes);
      }
    } catch {
      // If statfs unsupported or fails, permit save
    }
    return true;
  }
}
