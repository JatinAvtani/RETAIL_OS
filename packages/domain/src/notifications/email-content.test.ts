import { describe, expect, it } from 'vitest';
import { buildNotificationEmailContent } from './email-content.js';

describe('buildNotificationEmailContent', () => {
  it('includes severity and a formatted dollar impact in the subject when one exists', () => {
    const content = buildNotificationEmailContent({
      title: '3 lots expiring',
      body: '12kg cream and 8kg berries expire in 2 days.',
      severity: 'HIGH',
      dollarImpact: '1234.5000',
    });
    expect(content.subject).toBe('[HIGH] 3 lots expiring [1,234.50 at stake]');
    expect(content.bodyText).toBe('12kg cream and 8kg berries expire in 2 days.');
  });

  it('never fabricates a dollar impact when the rule type has none (I7)', () => {
    const content = buildNotificationEmailContent({
      title: 'Stock below reorder point',
      body: 'Product X at store Y is at or below its configured reorder point.',
      severity: 'HIGH',
      dollarImpact: null,
    });
    expect(content.subject).toBe('[HIGH] Stock below reorder point');
    expect(content.subject).not.toContain('at stake');
  });

  it('trims trailing zeros but keeps at least two fractional digits', () => {
    const content = buildNotificationEmailContent({
      title: 'X',
      body: 'Y',
      severity: 'MEDIUM',
      dollarImpact: '100.0000',
    });
    expect(content.subject).toContain('100.00');
  });

  it('never rounds away real sub-cent precision', () => {
    const content = buildNotificationEmailContent({
      title: 'X',
      body: 'Y',
      severity: 'MEDIUM',
      dollarImpact: '0.0010',
    });
    expect(content.subject).toContain('0.001');
  });
});
