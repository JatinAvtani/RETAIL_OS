/**
 * Turns a real `notifications` row (title, body, severity, dollarImpact) into an email
 * subject/body — pure formatting only (I1), no I/O. `dollarImpact` is a raw NUMERIC string with
 * no currency code (`notifications.dollarImpact`'s own schema comment), so this never attaches a
 * fabricated `$`/currency symbol — matches the established convention in `apps/web`'s
 * `notification-bell`/`/notifications` page and `packages/assistant/src/briefing.ts`, which carry
 * the same raw figure through unlabeled rather than guessing a currency.
 */

export interface NotificationEmailInput {
  title: string;
  body: string;
  severity: string;
  dollarImpact: string | null;
}

export interface NotificationEmailContent {
  subject: string;
  bodyText: string;
}

/** Trims trailing zero fractional digits but never below two places — same rule this codebase's other money-display code already applies, just without a currency symbol. */
const formatDollarImpact = (raw: string): string => {
  const [intPart, fracRaw = ''] = raw.split('.');
  const grouped = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracTrimmed = fracRaw.replace(/0+$/, '');
  const frac = (fracTrimmed + '00').slice(0, Math.max(2, fracTrimmed.length));
  return `${grouped}.${frac}`;
};

export const buildNotificationEmailContent = (notification: NotificationEmailInput): NotificationEmailContent => {
  const impactSuffix = notification.dollarImpact !== null ? ` [${formatDollarImpact(notification.dollarImpact)} at stake]` : '';
  return {
    subject: `[${notification.severity}] ${notification.title}${impactSuffix}`,
    bodyText: notification.body,
  };
};
