import { describe, it, expect } from 'vitest';
import { formatPipDate } from './pipRoutes.js';

describe('formatPipDate', () => {
  it('formats standard ISO timestamp string in readable day-month-year', () => {
    expect(formatPipDate('2026-10-09T14:30:00.000Z')).toBe('9 Oct 2026');
  });

  it('formats date-only ISO string deterministically in UTC without timezone drift', () => {
    expect(formatPipDate('2026-01-01')).toBe('1 Jan 2026');
    expect(formatPipDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('handles leap years and different months', () => {
    expect(formatPipDate('2028-02-29')).toBe('29 Feb 2028');
  });

  it('returns fallback value if input is not a valid date', () => {
    expect(formatPipDate('not-a-date')).toBe('not-a-date');
  });
});
