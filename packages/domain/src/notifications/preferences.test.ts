import { describe, expect, it } from 'vitest';
import { isChannelMuted, isWithinQuietHours, shouldSuppressDelivery, type NotificationPreference } from './preferences.js';

const NO_PREFERENCE: NotificationPreference = {
  mutedChannels: [],
  quietHoursStartHour: null,
  quietHoursEndHour: null,
  criticalOverridesQuietHours: true,
};

describe('isChannelMuted', () => {
  it('is true only for a channel explicitly in mutedChannels', () => {
    expect(isChannelMuted({ ...NO_PREFERENCE, mutedChannels: ['SMS'] }, 'SMS')).toBe(true);
    expect(isChannelMuted({ ...NO_PREFERENCE, mutedChannels: ['SMS'] }, 'EMAIL')).toBe(false);
  });

  it('is false when nothing is muted', () => {
    expect(isChannelMuted(NO_PREFERENCE, 'EMAIL')).toBe(false);
  });
});

describe('isWithinQuietHours', () => {
  it('returns false when either bound is unset', () => {
    expect(isWithinQuietHours(23, null, 7)).toBe(false);
    expect(isWithinQuietHours(23, 22, null)).toBe(false);
    expect(isWithinQuietHours(23, null, null)).toBe(false);
  });

  it('a non-wrapping window (e.g. 9-17) suppresses only inside the range', () => {
    expect(isWithinQuietHours(10, 9, 17)).toBe(true);
    expect(isWithinQuietHours(9, 9, 17)).toBe(true); // start is inclusive
    expect(isWithinQuietHours(17, 9, 17)).toBe(false); // end is exclusive
    expect(isWithinQuietHours(8, 9, 17)).toBe(false);
    expect(isWithinQuietHours(18, 9, 17)).toBe(false);
  });

  it('a wrapping window (e.g. 22-7) suppresses both late night AND early morning', () => {
    expect(isWithinQuietHours(23, 22, 7)).toBe(true);
    expect(isWithinQuietHours(22, 22, 7)).toBe(true); // start inclusive
    expect(isWithinQuietHours(0, 22, 7)).toBe(true);
    expect(isWithinQuietHours(6, 22, 7)).toBe(true);
    expect(isWithinQuietHours(7, 22, 7)).toBe(false); // end exclusive
    expect(isWithinQuietHours(12, 22, 7)).toBe(false); // midday, well outside
  });

  it('a zero-width window (start === end) suppresses nothing, not the whole day', () => {
    expect(isWithinQuietHours(0, 5, 5)).toBe(false);
    expect(isWithinQuietHours(12, 5, 5)).toBe(false);
    expect(isWithinQuietHours(23, 5, 5)).toBe(false);
  });
});

describe('shouldSuppressDelivery', () => {
  const timezone = 'America/New_York';

  it('a muted channel always suppresses, even outside quiet hours', () => {
    const noon = new Date('2026-08-22T16:00:00Z'); // ~noon in America/New_York
    const preference: NotificationPreference = { ...NO_PREFERENCE, mutedChannels: ['SMS'] };
    expect(shouldSuppressDelivery(preference, 'SMS', 'HIGH', noon, timezone)).toBe(true);
  });

  it('no quiet hours configured never suppresses a non-muted channel', () => {
    const midnight = new Date('2026-08-22T04:00:00Z'); // ~midnight in America/New_York
    expect(shouldSuppressDelivery(NO_PREFERENCE, 'EMAIL', 'HIGH', midnight, timezone)).toBe(false);
  });

  it('inside configured quiet hours, a non-CRITICAL alert is suppressed', () => {
    const twoAm = new Date('2026-08-22T06:00:00Z'); // ~02:00 in America/New_York
    const preference: NotificationPreference = { ...NO_PREFERENCE, quietHoursStartHour: 22, quietHoursEndHour: 7 };
    expect(shouldSuppressDelivery(preference, 'EMAIL', 'HIGH', twoAm, timezone)).toBe(true);
  });

  it('inside configured quiet hours, a CRITICAL alert overrides when criticalOverridesQuietHours is true', () => {
    const twoAm = new Date('2026-08-22T06:00:00Z');
    const preference: NotificationPreference = {
      ...NO_PREFERENCE,
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: true,
    };
    expect(shouldSuppressDelivery(preference, 'EMAIL', 'CRITICAL', twoAm, timezone)).toBe(false);
  });

  it('inside configured quiet hours, a CRITICAL alert is STILL suppressed when the user disabled the override', () => {
    const twoAm = new Date('2026-08-22T06:00:00Z');
    const preference: NotificationPreference = {
      ...NO_PREFERENCE,
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: false,
    };
    expect(shouldSuppressDelivery(preference, 'EMAIL', 'CRITICAL', twoAm, timezone)).toBe(true);
  });

  it('outside configured quiet hours, even a muted-channel check does not apply to an unrelated channel', () => {
    const noon = new Date('2026-08-22T16:00:00Z');
    const preference: NotificationPreference = {
      mutedChannels: ['SMS'],
      quietHoursStartHour: 22,
      quietHoursEndHour: 7,
      criticalOverridesQuietHours: true,
    };
    expect(shouldSuppressDelivery(preference, 'EMAIL', 'HIGH', noon, timezone)).toBe(false);
  });
});
