import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { sanitizeFileName, resolveSafePath } from '../src/main/storage/sanitize';
import { FileSink } from '../src/main/storage/FileSink';

describe('sanitizeFileName (SECURITY §5)', () => {
  it('handles empty and null inputs safely', () => {
    const fixedTime = 123456789;
    expect(sanitizeFileName('', fixedTime)).toBe('file_123456789');
    expect(sanitizeFileName(null as unknown as string, fixedTime)).toBe('file_123456789');
    expect(sanitizeFileName('   ', fixedTime)).toBe('file_123456789');
    expect(sanitizeFileName('...', fixedTime)).toBe('file_123456789');
  });

  it('neutralizes path traversal attempts', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\calc.exe')).toBe('calc.exe');
    expect(sanitizeFileName('C:\\secret\\file.txt')).toBe('file.txt');
    expect(sanitizeFileName('/var/log/syslog')).toBe('syslog');
    expect(sanitizeFileName('foo/bar/baz.png')).toBe('baz.png');
  });

  it('prefixes Windows reserved device names', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('prn.pdf')).toBe('_prn.pdf');
    expect(sanitizeFileName('aux')).toBe('_aux');
    expect(sanitizeFileName('NUL.tar.gz')).toBe('_NUL.tar.gz');
    expect(sanitizeFileName('com1.dat')).toBe('_com1.dat');
    expect(sanitizeFileName('LPT5.jpg')).toBe('_LPT5.jpg');
  });

  it('removes or replaces control characters and forbidden symbols', () => {
    expect(sanitizeFileName('hello*world?.txt')).toBe('hello_world_.txt');
    expect(sanitizeFileName('a<b:c>d|e.doc')).toBe('a_b_c_d_e.doc');
    expect(sanitizeFileName('tab\tnewline\n.txt')).toBe('tab_newline_.txt');
  });

  it('normalizes unicode via NFC', () => {
    const decomposed = 'e\u0301'; // é in NFD
    const sanitized = sanitizeFileName(decomposed);
    expect(sanitized).toBe('é');
  });

  it('truncates overly long filenames while preserving extension', () => {
    const longBase = 'a'.repeat(300);
    const sanitized = sanitizeFileName(`${longBase}.tar.gz`);
    expect(sanitized.length).toBeLessThanOrEqual(200);
    expect(sanitized.endsWith('.tar.gz')).toBe(true);
  });
});

describe('resolveSafePath', () => {
  const testDir = path.resolve('temp_test_dir');

  it('allows safe files directly inside the directory', () => {
    const safe = resolveSafePath(testDir, 'photo.jpg');
    expect(safe).toBe(path.join(testDir, 'photo.jpg'));
  });

  it('throws on path traversal that breaks out of directory', () => {
    expect(() => resolveSafePath(testDir, '../evil.exe')).toThrow('Path traversal detected');
    expect(() => resolveSafePath(testDir, '..\\evil.exe')).toThrow('Path traversal detected');
  });
});

describe('FileSink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'filesink-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves file from readable stream atomically with .part renaming', async () => {
    const sink = new FileSink({ downloadDir: tmpDir });
    const content = Buffer.from('Antigravity high performance file stream test content');
    const stream = Readable.from(content);

    const result = await sink.saveFile({ originalName: 'sample.txt' }, stream);

    expect(result.fileName).toBe('sample.txt');
    expect(result.size).toBe(content.length);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.existsSync(`${result.filePath}.part`)).toBe(false);

    const savedContent = await fs.promises.readFile(result.filePath);
    expect(savedContent.equals(content)).toBe(true);
  });

  it('resolves naming conflicts by appending numbering', async () => {
    const sink = new FileSink({ downloadDir: tmpDir });

    // Save first file
    await sink.saveFile({ originalName: 'report.pdf' }, Readable.from(Buffer.from('first')));
    // Save second file with same name
    const result2 = await sink.saveFile({ originalName: 'report.pdf' }, Readable.from(Buffer.from('second')));
    // Save third file with same name
    const result3 = await sink.saveFile({ originalName: 'report.pdf' }, Readable.from(Buffer.from('third')));

    expect(result2.fileName).toBe('report (1).pdf');
    expect(result3.fileName).toBe('report (2).pdf');

    expect(await fs.promises.readFile(result2.filePath, 'utf8')).toBe('second');
    expect(await fs.promises.readFile(result3.filePath, 'utf8')).toBe('third');
  });

  it('cleans up .part file on stream error or abort', async () => {
    const sink = new FileSink({ downloadDir: tmpDir });
    const errorStream = new Readable({
      read() {
        this.emit('error', new Error('network_connection_lost'));
      }
    });

    await expect(sink.saveFile({ originalName: 'aborted.dat' }, errorStream)).rejects.toThrow('network_connection_lost');

    const filesInDir = await fs.promises.readdir(tmpDir);
    expect(filesInDir.length).toBe(0); // .part must be unlinked
  });

  it('rejects files exceeding maxFileSizeBytes and cleans up', async () => {
    const sink = new FileSink({ downloadDir: tmpDir, maxFileSizeBytes: 100 });
    const largeChunk = Buffer.alloc(200, 'x');
    const stream = Readable.from(largeChunk);

    await expect(sink.saveFile({ originalName: 'too_large.bin' }, stream)).rejects.toThrow('file_too_large');

    const filesInDir = await fs.promises.readdir(tmpDir);
    expect(filesInDir.length).toBe(0);
  });

  it('streams large synthetic data with constant memory usage', async () => {
    const sink = new FileSink({ downloadDir: tmpDir });
    const totalBytes = 50 * 1024 * 1024; // 50 MB synthetic stream for quick test
    const chunkSize = 64 * 1024;
    let bytesSent = 0;

    const initialMem = process.memoryUsage().heapUsed;

    const generatorStream = new Readable({
      read() {
        if (bytesSent >= totalBytes) {
          this.push(null);
          return;
        }
        const remaining = totalBytes - bytesSent;
        const currentChunkSize = Math.min(chunkSize, remaining);
        bytesSent += currentChunkSize;
        this.push(Buffer.alloc(currentChunkSize, 0xaa));
      }
    });

    const result = await sink.saveFile({ originalName: 'large_synthetic.bin' }, generatorStream);
    const finalMem = process.memoryUsage().heapUsed;

    expect(result.size).toBe(totalBytes);
    // Heap increase should be much smaller than the total stream size (stream doesn't buffer in RAM)
    const memDelta = Math.abs(finalMem - initialMem);
    expect(memDelta).toBeLessThan(totalBytes / 2);
  });
});
