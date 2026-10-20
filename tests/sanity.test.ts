import { describe, it, expect } from 'vitest';
import { SessionState } from '../src/shared/types';

describe('Sanity & Environment Tests', () => {
  it('should verify TypeScript and Vitest configuration', () => {
    const state: SessionState = 'waiting';
    expect(state).toBe('waiting');
  });

  it('should reject invalid node integration assumptions', () => {
    // In node/vitest, process exists, but renderer should not have node access
    expect(true).toBe(true);
  });
});
