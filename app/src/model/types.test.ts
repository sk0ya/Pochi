import { describe, expect, it, vi } from 'vitest';
import { GRID, emptyDoc, newId, snap, snapPt } from './types';

describe('GRID', () => {
  it('is 16', () => {
    expect(GRID).toBe(16);
  });
});

describe('snap', () => {
  it('rounds to the nearer grid line, up or down', () => {
    expect(snap(7)).toBe(0);
    expect(snap(9)).toBe(16);
  });

  it('rounds an exact half-grid value up (Math.round half-away-from-zero for positives)', () => {
    // 24 / 16 = 1.5 -> Math.round(1.5) = 2 -> 32
    expect(snap(24)).toBe(32);
  });

  it('handles values already on the grid and negative values', () => {
    expect(snap(32)).toBe(32);
    expect(snap(-20)).toBe(-16);
  });
});

describe('snapPt', () => {
  it('snaps both coordinates independently', () => {
    expect(snapPt({ x: 7, y: 24 })).toEqual({ x: 0, y: 32 });
  });
});

describe('emptyDoc', () => {
  it('returns a fresh, empty shapes/connectors doc each call (not a shared reference)', () => {
    const a = emptyDoc();
    const b = emptyDoc();
    expect(a).toEqual({ shapes: [], connectors: [] });
    expect(a).not.toBe(b);
  });
});

describe('newId', () => {
  it('produces distinct base36 strings for distinct Math.random values (deterministic via spy)', () => {
    const spy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);
    try {
      const a = newId();
      const b = newId();
      // newId = Math.random().toString(36).slice(2, 10): base36 fraction digits.
      expect(a).toBe((0.123456789).toString(36).slice(2, 10));
      expect(a).toMatch(/^[a-z0-9]+$/);
      expect(a).not.toBe(b);
    } finally {
      spy.mockRestore();
    }
  });
});
