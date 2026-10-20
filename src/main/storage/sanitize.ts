import path from 'path';

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

// Control characters (0x00-0x1F, 0x7F) and <>:"|?*
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS_REGEX = /[\x00-\x1f\x7f<>:"/\\|?*]/g;

/**
 * Sanitizes an incoming file name for safe storage on the local filesystem.
 */
export function sanitizeFileName(rawName: string, timestamp = Date.now()): string {
  if (!rawName || typeof rawName !== 'string') {
    return `file_${timestamp}`;
  }

  // 1. Unicode NFC normalize
  let name = rawName.normalize('NFC');

  // 2. path.basename equivalent removing both '/' and '\' path separators
  name = name.replace(/\\/g, '/');
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash !== -1) {
    name = name.slice(lastSlash + 1);
  }

  // 3. Replace control characters and <>:"/\|?* with '_'
  name = name.replace(FORBIDDEN_CHARS_REGEX, '_');

  // 4. Trim leading and trailing dots and spaces
  name = name.replace(/^[\s.]+|[\s.]+$/g, '');

  // 5. Detect extension (supporting compound extensions like .tar.gz)
  let ext = '';
  let baseName = name;
  const compoundMatch = name.match(/(\.tar\.(?:gz|bz2|xz|zst))$/i);
  if (compoundMatch) {
    ext = compoundMatch[1];
    baseName = name.slice(0, -ext.length);
  } else {
    const extIndex = name.lastIndexOf('.');
    if (extIndex !== -1) {
      ext = name.slice(extIndex);
      baseName = name.slice(0, extIndex);
    }
  }

  // Windows reserved names check: any name whose root (before first dot) or base is reserved
  const rootPart = name.split('.')[0];
  if (
    WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase()) ||
    WINDOWS_RESERVED_NAMES.has(rootPart.toUpperCase())
  ) {
    name = `_${name}`;
    baseName = `_${baseName}`;
  }

  // 6. Max length <= 200 characters while preserving the extension
  const MAX_LENGTH = 200;
  if (name.length > MAX_LENGTH) {
    if (ext.length > 50) {
      name = name.slice(0, MAX_LENGTH);
    } else {
      const allowedBaseLength = MAX_LENGTH - ext.length;
      name = `${baseName.slice(0, allowedBaseLength)}${ext}`;
    }
  }

  // 7. If empty after sanitization, fallback to file_<timestamp>
  if (!name || name.trim().length === 0) {
    return `file_${timestamp}`;
  }

  return name;
}

/**
 * Validates that resolved target path stays within downloadDir (path traversal guard).
 */
export function resolveSafePath(downloadDir: string, sanitizedFileName: string): string {
  const resolvedDir = path.resolve(downloadDir);
  const targetPath = path.resolve(resolvedDir, sanitizedFileName);

  // Must start with downloadDir + path.sep
  if (!targetPath.startsWith(resolvedDir + path.sep) && targetPath !== resolvedDir) {
    throw new Error('Path traversal detected');
  }

  return targetPath;
}
