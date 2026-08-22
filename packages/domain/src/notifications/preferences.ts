import { resolveLocalHour } from '../time/store-time.js';
import type { AlertSeverity } from './rule-engine.js';

/**
 * Per-USER channel/quiet-hours preferences — pure decision logic (I1), no I/O. The caller
 * (fan-out) resolves the real preference row (`NotificationPreferenceRepository.findOrDefaultForUser`)
 * and the real store timezone to evaluate against; this module only decides whether a specific
 * (user, channel, severity, instant) delivery should actually be suppressed.
 */
export interface NotificationPreference {
  mutedChannels: string[];
  quietHoursStartHour: number | null;
  quietHoursEndHour: number | null;
  criticalOverridesQuietHours: boolean;
}

/**
 * A channel the user has muted is suppressed unconditionally — this is a stronger, unconditional
 * opt-out, distinct from quiet hours (which is time-windowed and can be overridden by severity).
 */
export const isChannelMuted = (preference: NotificationPreference, channel: string): boolean =>
  preference.mutedChannels.includes(channel);

/**
 * Whether `localHour` (0-23) falls inside the configured quiet-hours window. Handles a window that
 * WRAPS midnight (e.g. start=22, end=7 means "quiet from 22:00 through 06:59") — a plain
 * `start <= hour < end` range check is wrong whenever start > end, which is the common real case
 * for a nighttime window. Returns `false` when either bound is unset (both-or-neither, matching the
 * schema's own documented pairing) — no quiet hours configured means never suppressed by time.
 */
export const isWithinQuietHours = (
  localHour: number,
  quietHoursStartHour: number | null,
  quietHoursEndHour: number | null
): boolean => {
  if (quietHoursStartHour === null || quietHoursEndHour === null) return false;
  if (quietHoursStartHour === quietHoursEndHour) return false; // a zero-width window suppresses nothing
  if (quietHoursStartHour < quietHoursEndHour) {
    return localHour >= quietHoursStartHour && localHour < quietHoursEndHour;
  }
  // Wraps midnight: quiet from start through 23, AND from 0 through end (exclusive).
  return localHour >= quietHoursStartHour || localHour < quietHoursEndHour;
};

/**
 * The single decision point fan-out consults per (recipient, channel): should this delivery be
 * suppressed right now? A muted channel always suppresses. Quiet hours suppress UNLESS the
 * notification is CRITICAL and the user's own `criticalOverridesQuietHours` toggle is true — the
 * acceptance criteria's own "critical alerts configurably override" made real, not hardcoded either
 * way. `instant`/`timezone` resolve to a real local hour via `resolveLocalHour` (the same store-time
 * module every other period-boundary calculation in this codebase already uses) — never a
 * server-time or UTC-hour shortcut.
 */
export const shouldSuppressDelivery = (
  preference: NotificationPreference,
  channel: string,
  severity: AlertSeverity,
  instant: Date,
  timezone: string
): boolean => {
  if (isChannelMuted(preference, channel)) return true;

  const localHour = resolveLocalHour(instant, timezone);
  const inQuietHours = isWithinQuietHours(localHour, preference.quietHoursStartHour, preference.quietHoursEndHour);
  if (!inQuietHours) return false;

  const overridden = severity === 'CRITICAL' && preference.criticalOverridesQuietHours;
  return !overridden;
};
