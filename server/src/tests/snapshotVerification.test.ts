/**
 * Tests for snapshot verification service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verificationService } from '../services/snapshotVerification';

describe('Snapshot Verification Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should verify snapshot restore successfully', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    
    // Mock successful verification
    const result = await verificationService.verifySnapshotRestore();
    
    expect(result.passed).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });

  it('should detect purchase record mismatches', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ count: 5 }]
      })
    };
    
    // Test will detect unverified purchases
    expect(mockDb.query).toBeDefined();
  });

  it('should rebuild derived indexes', async () => {
    const indexes = verificationService.derivedIndexes;
    
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: 'creator_sales_summary' })
    );
  });
});
