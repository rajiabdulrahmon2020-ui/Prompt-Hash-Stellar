/**
 * Tests for synthetic journey monitor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { journeyMonitor } from '../services/syntheticJourneyMonitor';

describe('Synthetic Journey Monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('should execute complete journey', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ prompts: [{ id: 'test-prompt-001' }] })
    });
    
    const result = await journeyMonitor.runSyntheticJourney();
    
    expect(result).toBeDefined();
    expect(result.steps).toHaveLength(3);
    expect(result.dependencies).toBeDefined();
  });

  it('should detect dependency failures', async () => {
    const deps = await journeyMonitor.checkDependencies();
    
    expect(deps).toBeInstanceOf(Array);
    expect(deps.length).toBeGreaterThan(0);
  });

  it('should measure step latency', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ prompts: [] })
    });
    
    const result = await journeyMonitor.runSyntheticJourney();
    
    result.steps.forEach(step => {
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
