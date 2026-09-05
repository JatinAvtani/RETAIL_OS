'use client';

import { useCallback, useEffect, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { shiftDecimalPoint } from '@/lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNotice, Field, Input, LoadingState, PageHeader, Select, Table, Th, Td, Tr, Value, type BadgeTone } from '@/components/ui';

type Tolerances = Awaited<ReturnType<typeof trpc.settings.getMatchTolerances.query>>;
type SessionSummary = Awaited<ReturnType<typeof trpc.auth.listSessions.query>>[number];
type Member = Awaited<ReturnType<typeof trpc.invitations.listMembers.query>>[number];
type PendingInvitation = Awaited<ReturnType<typeof trpc.invitations.listPending.query>>[number];
type NotificationPreferences = Awaited<ReturnType<typeof trpc.notifications.getPreferences.query>>;
type TuningCandidate = Awaited<ReturnType<typeof trpc.notifications.listTuningCandidates.query>>[number];
type ActionRateReport = Awaited<ReturnType<typeof trpc.notifications.actionRateReport.query>>;
type StoreSummary = Awaited<ReturnType<typeof trpc.stores.list.query>>[number];
type StoreDetail = Awaited<ReturnType<typeof trpc.stores.get.query>>;

const DEFAULT_PRICE_PERCENT_LABEL = '2%';
// No currency symbol: the tolerance compares against invoice amounts in the org's own currency,
// and this UI does not know a symbol for it — "$" on an INR org's screen was a real, visible leak.
const DEFAULT_PRICE_ABSOLUTE_LABEL = '5.00';
const DEFAULT_QUANTITY_PERCENT_LABEL = '2%';

/** Stored fraction → displayed percent: '0.02' → '2'. String decimal-shift — no float arithmetic on a business threshold. */
const fractionToPercent = (fraction: string): string => shiftDecimalPoint(fraction, 2);
/** Typed percent → stored fraction: '2' → '0.02'. */
const percentToFraction = (percent: string): string => shiftDecimalPoint(percent, -2);

const ROLES = ['OWNER', 'MANAGER', 'STAFF', 'VIEWER_FINANCE'] as const;

const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  VIEWER_FINANCE: 'Finance viewer (read-only)',
};

/**
 * A raw `navigator.userAgent` string ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
 * (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36") is real data but unreadable as a device
 * label — nobody scans that to tell two sessions apart. Deliberately simple substring checks, not a
 * parsing library: this only needs to answer "which browser, which OS," not power any real
 * decision, so a full UA-parser dependency would be a real cost for a cosmetic label.
 */
const describeDevice = (userAgent: string): string => {
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Chrome/')
      ? 'Chrome'
      : userAgent.includes('Firefox/')
        ? 'Firefox'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'Unknown browser';
  const os = userAgent.includes('Windows')
    ? 'Windows'
    : userAgent.includes('Mac OS X')
      ? 'macOS'
      : userAgent.includes('Android')
        ? 'Android'
        : userAgent.includes('iPhone') || userAgent.includes('iPad')
          ? 'iOS'
          : userAgent.includes('Linux')
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
};

const describeLastSeen = (lastSeenAt: string): string => {
  const minutes = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60000);
  if (minutes < 1) return 'Active now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

/**
 * "Active sessions" — `SessionStore.listForUser`/`revoke` (packages/session) were real, fully
 * built, and already used internally by logout/password-reset, but had no user-triggered exposure
 * anywhere: a compromised or simply forgotten device (a shared café computer, an old phone) had no
 * way to be reviewed or cut off short of resetting the account password (which revokes ALL
 * sessions, including the one you're using right now). This panel is the missing "revoke just this
 * one" path. `sessionHash` is a one-way hash of the real Redis token (`auth.ts`'s own
 * `hashSessionToken`) — the raw token itself is never sent to the browser after login, so this UI
 * never has the ability to display or leak a live credential, only to name a row for revocation.
 *
 * Revoking is a real, irreversible action (that device is logged out immediately, no undo) with no
 * shared confirm-dialog component anywhere in this codebase yet (`Button`'s own `danger` variant
 * comment says as much: "anything irreversible needs a confirmation step as well — the button's
 * styling is not the safeguard"). Rather than block on building a modal for one panel, this uses an
 * armed two-click pattern local to each row: the first click arms that row ("Confirm revoke?"), a
 * second click on the SAME row within the armed state actually revokes, and clicking elsewhere
 * (or the row re-rendering after `load()`) disarms it — cheap, and still a genuine extra step
 * before an irreversible action fires.
 */
const SessionsPanel = () => {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.auth.listSessions
      .query()
      .then((result) => setSessions(result))
      .catch((err) => {
        setError(err instanceof TRPCClientError ? err.message : 'Could not load your active sessions.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (sessionHash: string) => {
    if (armedId !== sessionHash) {
      setArmedId(sessionHash);
      return;
    }

    setBusyId(sessionHash);
    setArmedId(null);
    setError(null);
    try {
      await trpc.auth.revokeSession.mutate({ sessionHash });
      if (sessions?.find((s) => s.sessionHash === sessionHash)?.isCurrent) {
        // Revoking the session this very tab is using — the server already cleared the cookie;
        // the next navigation would hit AuthGuard's own redirect anyway, but reloading now avoids
        // a stale, already-dead session sitting in this tab's memory in the meantime.
        window.location.href = '/login';
        return;
      }
      load();
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not revoke that session.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <Card className="mb-6">
        <CardHeader title="Active sessions" />
        <LoadingState />
      </Card>
    );
  }

  if (error && !sessions) {
    return (
      <Card className="mb-6">
        <CardHeader title="Active sessions" />
        <ErrorNotice>{error}</ErrorNotice>
      </Card>
    );
  }

  return (
    <Card className="mb-6">
      <CardHeader title="Active sessions" />
      {error && (
        <div className="px-5 pt-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}

      {sessions && sessions.length === 0 ? (
        <EmptyState title="No active sessions" hint="You aren't signed in anywhere right now." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Device</Th>
              <Th>Last active</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {sessions?.map((session) => (
              <Tr key={session.sessionHash}>
                <Td className="max-w-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate" title={session.userAgent}>
                      {describeDevice(session.userAgent)}
                    </span>
                    {session.isCurrent && <Badge tone="positive">This device</Badge>}
                  </div>
                  <div className="text-xs text-content-subtle">{session.ip}</div>
                </Td>
                <Td>{describeLastSeen(session.lastSeenAt)}</Td>
                <Td align="right">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busyId === session.sessionHash}
                    aria-pressed={armedId === session.sessionHash}
                    onClick={() => revoke(session.sessionHash)}
                  >
                    {armedId === session.sessionHash ? 'Confirm revoke?' : session.isCurrent ? 'Log out this device' : 'Revoke'}
                  </Button>
                  {armedId === session.sessionHash && (
                    <span role="status" className="sr-only">
                      Click Revoke again to confirm — this cannot be undone.
                    </span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
};

/**
 * The "team" half of settings — previously didn't exist visually at all, even though
 * `invitations.create`/`accept` and the full 4-role permission model were fully built server-side
 * (a real gap found by the UI audit). `users:manage`-gated on the backend; this panel doesn't
 * separately hide itself for a non-OWNER — a MANAGER/STAFF caller genuinely lacking the permission
 * gets a real 403 from the query itself, rendered as this section's own error state, matching how
 * every other permission-gated panel in this app behaves (no silent hiding of a section a
 * differently-permissioned caller could otherwise discover exists).
 */
const TeamPanel = () => {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pending, setPending] = useState<PendingInvitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<(typeof ROLES)[number]>('STAFF');
  const [inviting, setInviting] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([trpc.invitations.listMembers.query(), trpc.invitations.listPending.query()])
      .then(([membersResult, pendingResult]) => {
        setMembers(membersResult);
        setPending(pendingResult);
      })
      .catch((err) => {
        setError(err instanceof TRPCClientError ? err.message : 'Could not load the team.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const invite = async () => {
    setInviting(true);
    setError(null);
    setDevToken(null);
    try {
      const result = await trpc.invitations.create.mutate({ email: inviteEmail, role: inviteRole, storeIds: null });
      setInviteEmail('');
      // No email-sending infrastructure exists yet — same real, documented posture as signup's own
      // verification token. Shown directly so the invite flow is exercisable end-to-end.
      // `?? null` because the API omits this entirely in production (see `devOnlyToken`) — the
      // panel then simply shows no token, which is the honest state, not an error.
      setDevToken(result._devOnlyInvitationToken ?? null);
      load();
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not send the invitation.');
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (membershipId: string, role: (typeof ROLES)[number]) => {
    setBusyId(membershipId);
    setError(null);
    try {
      await trpc.invitations.updateRole.mutate({ membershipId, role });
      load();
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not change that member’s role.');
    } finally {
      setBusyId(null);
    }
  };

  const removeMember = async (membershipId: string) => {
    setBusyId(membershipId);
    setError(null);
    try {
      await trpc.invitations.removeMember.mutate({ membershipId });
      load();
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not remove that member.');
    } finally {
      setBusyId(null);
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    setBusyId(invitationId);
    setError(null);
    try {
      await trpc.invitations.revoke.mutate({ invitationId });
      load();
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not revoke that invitation.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <Card className="mb-6">
        <CardHeader title="Team" />
        <LoadingState />
      </Card>
    );
  }

  if (error && !members) {
    return (
      <Card className="mb-6">
        <CardHeader title="Team" />
        <ErrorNotice>{error}</ErrorNotice>
      </Card>
    );
  }

  return (
    <Card className="mb-6">
      <CardHeader title="Team" />
      {error && (
        <div className="px-5 pt-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4">
        <Field label="Invite by email">
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@yourcafe.com"
            className="w-64"
          />
        </Field>
        <Field label="Role">
          <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as (typeof ROLES)[number])} className="w-auto">
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="button" variant="primary" disabled={inviting || inviteEmail.trim() === ''} onClick={invite}>
          {inviting ? 'Sending…' : 'Send invite'}
        </Button>
      </div>
      {devToken && (
        <p className="border-b border-border bg-surface-sunken/50 px-5 py-3 text-xs text-content-subtle">
          No email delivery is configured yet — share this link with the invitee directly:{' '}
          <span className="font-mono font-medium text-content">
            /invitations/accept?token={devToken}
          </span>
        </p>
      )}

      <Table>
        <thead>
          <tr>
            <Th>Member</Th>
            <Th>Role</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {members?.map((member) => (
            <Tr key={member.membershipId}>
              <Td>
                <div>{member.name ?? member.email}</div>
                {member.name && <div className="text-xs text-content-subtle">{member.email}</div>}
              </Td>
              <Td>
                <Select
                  value={member.role}
                  disabled={busyId === member.membershipId}
                  onChange={(e) => changeRole(member.membershipId, e.target.value as (typeof ROLES)[number])}
                  className="w-auto"
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </Select>
              </Td>
              <Td align="right">
                <Button
                  type="button"
                  variant="danger"
                  disabled={busyId === member.membershipId}
                  onClick={() => removeMember(member.membershipId)}
                >
                  Remove
                </Button>
              </Td>
            </Tr>
          ))}
          {pending?.map((invitation) => (
            <Tr key={invitation.id}>
              <Td>
                {invitation.email} <Badge tone="warning">Invited</Badge>
              </Td>
              <Td>{ROLE_LABELS[invitation.role as (typeof ROLES)[number]] ?? invitation.role}</Td>
              <Td align="right">
                <Button type="button" variant="ghost" disabled={busyId === invitation.id} onClick={() => revokeInvitation(invitation.id)}>
                  Revoke
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
};

/**
 * A store's own detail, keyed by id — the real gap `stores.get`'s own doc comment implies ("the
 * first endpoint proving object-level store scoping") but that no page anywhere ever called: the
 * app only ever showed a bare store-name dropdown for filtering (`useStores`), never a place to
 * see a single store's timezone, address, or status. Deliberately a plain expand-in-place using
 * the row already on screen for the collapsed state, and a real `stores.get` fetch (not the
 * already-loaded `list` row) once expanded — the endpoint's whole reason to exist is the
 * object-level access check on a single id, which reusing the list response would skip entirely.
 */
const StoreDetailRow = ({ store }: { store: StoreSummary }) => {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<StoreDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (detail) return;
    setLoading(true);
    setError(null);
    trpc.stores.get
      .query({ id: store.id })
      .then(setDetail)
      .catch(() => setError('Could not load this store.'))
      .finally(() => setLoading(false));
  };

  return (
    <li className="px-5 py-3">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2.5">
          <span className="text-sm font-medium text-content">{store.name}</span>
          <Badge tone={store.status === 'active' ? 'positive' : 'neutral'}>{store.status}</Badge>
        </span>
        <span className="text-xs text-content-subtle">{expanded ? 'Hide' : 'View'} detail</span>
      </button>
      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          {loading && <p className="text-sm text-content-subtle">Loading…</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
          {detail && (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-content-subtle">Timezone</dt>
                <dd className="font-mono text-content">{detail.timezone}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-content-subtle">Address</dt>
                <dd className="text-content">
                  <Value value={detail.address} />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-content-subtle">Created</dt>
                <dd className="text-content-muted">{new Date(detail.createdAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-content-subtle">Status</dt>
                <dd className="text-content-muted">{detail.status === 'active' ? 'Active' : 'Closed'}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </li>
  );
};

/**
 * Every store the caller can access, each expandable to its own detail via `stores.get` — see
 * `StoreDetailRow`'s own comment for why this is a real fetch rather than reusing `list`'s rows.
 * No store-scoping gate needed here beyond what `stores.list` itself already applies (object-level
 * `memberships.store_ids`, matching the router's own doc comment on why this endpoint needs no
 * separate Permission check).
 */
const StoresPanel = () => {
  const [stores, setStores] = useState<StoreSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.stores.list
      .query()
      .then(setStores)
      .catch(() => setError('Could not load stores.'));
  }, []);

  return (
    <Card className="mb-6">
      <CardHeader title="Stores" />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {!error && stores === null && <LoadingState />}
      {!error && stores !== null && stores.length === 0 && (
        <EmptyState title="No stores available" hint="Every workspace gets a store when it's created." />
      )}
      {!error && stores !== null && stores.length > 0 && (
        <ul className="divide-y divide-border">
          {stores.map((store) => (
            <StoreDetailRow key={store.id} store={store} />
          ))}
        </ul>
      )}
    </Card>
  );
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const formatHour = (hour: number): string => `${hour.toString().padStart(2, '0')}:00`;

/**
 * A user's OWN notification preferences — never a target user id, so this panel needs no
 * store/permission gate (matching the router's own reasoning: it always acts on the caller's own
 * row). EMAIL is the only channel offered to mute, since it's the only real transport currently
 * built — offering to mute a channel with no real sender would be a fake
 * control. Quiet hours are entered as plain local hours (0-23); "start === end" is a documented
 * zero-width no-op (see packages/domain/src/notifications/preferences.ts), so this UI treats an
 * unset pair as "no quiet hours" rather than exposing that edge case directly.
 */
const NotificationPreferencesPanel = () => {
  const [data, setData] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [muteEmail, setMuteEmail] = useState(false);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [startHour, setStartHour] = useState('22');
  const [endHour, setEndHour] = useState('7');
  const [criticalOverrides, setCriticalOverrides] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.notifications.getPreferences
      .query()
      .then((result) => {
        setData(result);
        setMuteEmail(result.mutedChannels.includes('EMAIL'));
        setQuietHoursEnabled(result.quietHoursStartHour !== null && result.quietHoursEndHour !== null);
        if (result.quietHoursStartHour !== null) setStartHour(String(result.quietHoursStartHour));
        if (result.quietHoursEndHour !== null) setEndHour(String(result.quietHoursEndHour));
        setCriticalOverrides(result.criticalOverridesQuietHours);
      })
      .catch((err) => {
        setError(err instanceof TRPCClientError ? err.message : 'Could not load your notification preferences.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await trpc.notifications.updatePreferences.mutate({
        mutedChannels: muteEmail ? ['EMAIL'] : [],
        quietHoursStartHour: quietHoursEnabled ? Number(startHour) : null,
        quietHoursEndHour: quietHoursEnabled ? Number(endHour) : null,
        criticalOverridesQuietHours: criticalOverrides,
      });
      setData(result);
      setSaved(true);
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not save your notification preferences.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card className="mb-6">
        <CardHeader title="Notification preferences" />
        <LoadingState />
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="mb-6">
        <CardHeader title="Notification preferences" />
        <ErrorNotice>{error}</ErrorNotice>
      </Card>
    );
  }

  return (
    <Card className="mb-6 p-6">
      <h2 className="mb-1 text-sm font-semibold text-content">Notification preferences</h2>
      <p className="mb-4 text-sm text-content-subtle">
        How and when you personally get notified — separate from what your organization alerts on.
      </p>

      {error && (
        <div className="mb-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm text-content">
          <input type="checkbox" checked={muteEmail} onChange={(e) => setMuteEmail(e.target.checked)} className="h-4 w-4" />
          Mute email notifications
        </label>

        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={quietHoursEnabled}
            onChange={(e) => setQuietHoursEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          Enable quiet hours
        </label>

        {quietHoursEnabled && (
          <div className="grid gap-4 pl-6 sm:grid-cols-2">
            <Field label="Quiet from" hint="Local time — can wrap past midnight">
              <Select value={startHour} onChange={(e) => setStartHour(e.target.value)}>
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Until">
              <Select value={endHour} onChange={(e) => setEndHour(e.target.value)}>
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {quietHoursEnabled && (
          <label className="flex items-center gap-2 pl-6 text-sm text-content">
            <input
              type="checkbox"
              checked={criticalOverrides}
              onChange={(e) => setCriticalOverrides(e.target.checked)}
              className="h-4 w-4"
            />
            Still notify me for critical alerts during quiet hours
          </label>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" variant="primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saved && <span className="text-sm text-positive">Saved.</span>}
      </div>
    </Card>
  );
};

const SEVERITY_OPTIONS = ['INFO', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const SEVERITY_TONE: Record<string, BadgeTone> = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  INFO: 'neutral',
};

const RULE_TYPE_LABELS: Record<string, string> = {
  stock_below_reorder: 'Stock below reorder point',
  lot_expiring: 'Lot expiring soon',
  supplier_price_increase: 'Supplier price increase',
  invoice_variance: 'Invoice variance',
  document_review_required: 'Document requires review',
  po_awaiting_approval: 'PO awaiting approval',
  negative_stock: 'Negative stock detected',
  unmapped_pos_items: 'Unmapped POS items accumulating',
  sales_anomaly: 'Sales anomaly',
  margin_drop: 'Margin drop',
  stocktake_variance: 'Stocktake variance',
  daily_briefing: 'Daily briefing',
};

/**
 * "Alert types with low action rates are surfaced for threshold tuning" (spec 05 §5.7)
 * made real. Reads `notifications.listTuningCandidates` (built on
 * `findRuleTypesNeedingTuning`, enriched with each flagged rule type's real configured row or the
 * catalogue default). Deliberately edits ONLY severity/recipient roles/channels, never a generic
 * "threshold" field — confirmed with the user: most rule types' real evaluation logic never reads
 * `notification_rules.threshold` at all (only `lot_expiring` does), so a generic threshold editor
 * would silently no-op for every other alert type. No auto-tuning and no digest channel either —
 * a human reviews and decides, matching this project's own "AI/automation drafts, humans decide"
 * discipline; there is no AI involved here, but the same "don't silently self-modify config"
 * reasoning applies.
 */
/**
 * The delivered/opened/acted evidence BEHIND the tuning panel below. Deliberately a separate,
 * read-only panel rather than more columns on that one: the tuning panel only lists rule types
 * that are already flagged as needing attention, so it can never answer "how is the alert channel
 * doing overall?" — a healthy rule type is invisible there by design. This report covers every
 * rule type with real history.
 */
const ActionRatePanel = () => {
  const [report, setReport] = useState<ActionRateReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trpc.notifications.actionRateReport
      .query({ days: 30 })
      .then(setReport)
      .catch((err) => setError(err instanceof TRPCClientError ? err.message : 'Could not load alert engagement.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card className="mb-6">
        <CardHeader title="Alert engagement" />
        <LoadingState />
      </Card>
    );
  }

  // A permission denial is a real, expected outcome here (`financial:read`), not a failure to
  // report as broken — a STAFF user simply doesn't see this panel.
  if (error || !report) return null;

  return (
    <Card className="mb-6 p-6">
      <h2 className="mb-1 text-sm font-semibold text-content">Alert engagement</h2>
      <p className="mb-4 text-sm text-content-subtle">
        Delivered, opened, and acted over the last 30 days. Action rate is per alert, not per
        recipient — one person acting resolves it for everyone it was sent to.
      </p>

      {report.byRuleType.length === 0 ? (
        <EmptyState
          title="No alerts sent yet"
          hint="Once notification rules start firing, their delivery and action rates appear here."
        />
      ) : (
        <Table aria-label="Alert engagement by type">
          <thead>
            <tr>
              <Th>Alert type</Th>
              <Th>Sent</Th>
              <Th>Acted</Th>
              <Th>Action rate</Th>
              <Th>Open rate</Th>
            </tr>
          </thead>
          <tbody>
            {report.byRuleType.map((row) => (
              <Tr key={row.ruleType}>
                <Td>{RULE_TYPE_LABELS[row.ruleType] ?? row.ruleType}</Td>
                <Td>{row.notificationCount}</Td>
                <Td>{row.actedCount}</Td>
                <Td>{Math.round(row.actionRate * 100)}%</Td>
                {/* `openRate` is genuinely null when nothing has ever been delivered for this type
                    — rendered as an honest unknown, never a fabricated 0% (I7). */}
                <Td>
                  <Value value={row.openRate === null ? null : `${Math.round(row.openRate * 100)}%`} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
};

const ThresholdTuningPanel = () => {
  const [candidates, setCandidates] = useState<TuningCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingRuleType, setSavingRuleType] = useState<string | null>(null);
  const [savedRuleType, setSavedRuleType] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Record<string, { severity: string; recipientRoles: string[]; emailEnabled: boolean }>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.notifications.listTuningCandidates
      .query({ days: 30 })
      .then((result) => {
        setCandidates(result);
        setDrafts(
          Object.fromEntries(
            result.map((c) => [
              c.ruleType,
              { severity: c.severity, recipientRoles: c.recipientRoles, emailEnabled: c.channels.includes('EMAIL') },
            ])
          )
        );
      })
      .catch((err) => {
        setError(err instanceof TRPCClientError ? err.message : 'Could not load threshold tuning candidates.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleRole = (ruleType: string, role: string) => {
    setDrafts((prev) => {
      const current = prev[ruleType];
      if (!current) return prev;
      const has = current.recipientRoles.includes(role);
      const recipientRoles = has ? current.recipientRoles.filter((r) => r !== role) : [...current.recipientRoles, role];
      return { ...prev, [ruleType]: { ...current, recipientRoles } };
    });
  };

  const save = async (candidate: TuningCandidate) => {
    const draft = drafts[candidate.ruleType];
    if (!draft || draft.recipientRoles.length === 0) return;
    setSavingRuleType(candidate.ruleType);
    setSavedRuleType(null);
    setError(null);
    try {
      const result = await trpc.notifications.updateRuleTuning.mutate({
        ruleId: candidate.ruleId,
        ruleType: candidate.ruleType,
        severity: draft.severity as (typeof SEVERITY_OPTIONS)[number],
        recipientRoles: draft.recipientRoles as ('OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER_FINANCE')[],
        channels: draft.emailEnabled ? ['EMAIL'] : [],
      });
      setCandidates((prev) => prev?.map((c) => (c.ruleType === candidate.ruleType ? { ...c, ruleId: result.ruleId } : c)) ?? null);
      setSavedRuleType(candidate.ruleType);
    } catch (err) {
      setError(err instanceof TRPCClientError ? err.message : 'Could not save this alert type.');
    } finally {
      setSavingRuleType(null);
    }
  };

  if (loading) {
    return (
      <Card className="mb-6">
        <CardHeader title="Alert threshold tuning" />
        <LoadingState />
      </Card>
    );
  }

  if (error && !candidates) {
    return (
      <Card className="mb-6">
        <CardHeader title="Alert threshold tuning" />
        <ErrorNotice>{error}</ErrorNotice>
      </Card>
    );
  }

  return (
    <Card className="mb-6 p-6">
      <h2 className="mb-1 text-sm font-semibold text-content">Alert threshold tuning</h2>
      <p className="mb-4 text-sm text-content-subtle">
        Alert types nobody acts on train people to ignore the whole channel. These have a low action
        rate over the last 30 days — narrow who gets them, change the severity, or turn off email so
        only the in-app centre shows them.
      </p>

      {error && (
        <div className="mb-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}

      {candidates && candidates.length === 0 && (
        <EmptyState
          title="Nothing needs tuning right now"
          hint="Every alert type either has too little history to judge yet, or a healthy action rate."
        />
      )}

      {candidates && candidates.length > 0 && (
        <div className="flex flex-col gap-6">
          {candidates.map((candidate) => {
            const draft = drafts[candidate.ruleType];
            if (!draft) return null;
            return (
              <div key={candidate.ruleType} className="border-b border-border pb-6 last:border-b-0 last:pb-0">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium text-content">
                    {RULE_TYPE_LABELS[candidate.ruleType] ?? candidate.ruleType}
                  </span>
                  <Badge tone={SEVERITY_TONE[draft.severity] ?? 'neutral'}>{draft.severity}</Badge>
                  <span className="text-xs text-content-subtle">
                    {candidate.actedCount} acted of {candidate.notificationCount} sent (
                    {Math.round(candidate.actionRate * 100)}%)
                  </span>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Severity">
                    <Select
                      value={draft.severity}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [candidate.ruleType]: { ...draft, severity: e.target.value } }))
                      }
                    >
                      {SEVERITY_OPTIONS.map((severity) => (
                        <option key={severity} value={severity}>
                          {severity}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label="Who receives it">
                    <div className="flex flex-wrap gap-3 pt-2">
                      {ROLES.map((role) => (
                        <label key={role} className="flex items-center gap-1.5 text-sm text-content">
                          <input
                            type="checkbox"
                            checked={draft.recipientRoles.includes(role)}
                            onChange={() => toggleRole(candidate.ruleType, role)}
                            className="h-4 w-4"
                          />
                          {ROLE_LABELS[role]}
                        </label>
                      ))}
                    </div>
                  </Field>
                </div>

                <label className="mt-3 flex items-center gap-2 text-sm text-content">
                  <input
                    type="checkbox"
                    checked={draft.emailEnabled}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [candidate.ruleType]: { ...draft, emailEnabled: e.target.checked } }))
                    }
                    className="h-4 w-4"
                  />
                  Send by email (always shows in the in-app notification centre either way)
                </label>

                {draft.recipientRoles.length === 0 && (
                  <p className="mt-2 text-xs text-danger">At least one recipient role is required.</p>
                )}

                <div className="mt-3 flex items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={savingRuleType === candidate.ruleType || draft.recipientRoles.length === 0}
                    onClick={() => save(candidate)}
                  >
                    {savingRuleType === candidate.ruleType ? 'Saving…' : 'Save'}
                  </Button>
                  {savedRuleType === candidate.ruleType && <span className="text-sm text-positive">Saved.</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

/**
 * "Avoid alert fatigue on cents": the real settings surface for the three-way
 * match's per-org tolerance override — OWNER-only. The percent fields DISPLAY and ACCEPT percent
 * ("2" under a "(%)" label) while `settings.updateMatchTolerances` stores the fraction (0.02) that
 * `classifyLineMatch` compares against — converted exactly once, at this boundary, by a string
 * decimal-point shift (`fractionToPercent`/`percentToFraction`), never float arithmetic. An
 * earlier version pushed the storage unit onto the user ("enter as 0.02" under a "(%)" label) in
 * the name of avoiding conversion; that was a label/value unit mismatch, which is the very error
 * class explicit-single-boundary conversion exists to prevent, not an application of it. An empty
 * field means "use the default," submitted as `null`, never a fabricated zero.
 */
export default function SettingsPage() {
  const [data, setData] = useState<Tolerances | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [pricePercent, setPricePercent] = useState('');
  const [priceAbsolute, setPriceAbsolute] = useState('');
  const [quantityPercent, setQuantityPercent] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.settings.getMatchTolerances
      .query()
      .then((result) => {
        setData(result);
        setPricePercent(result.matchPriceTolerancePercent ? fractionToPercent(result.matchPriceTolerancePercent) : '');
        setPriceAbsolute(result.matchPriceToleranceAbsolute ?? '');
        setQuantityPercent(result.matchQuantityTolerancePercent ? fractionToPercent(result.matchQuantityTolerancePercent) : '');
      })
      .catch((err) => {
        const message = err instanceof TRPCClientError ? err.message : 'Could not load settings.';
        setError(message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await trpc.settings.updateMatchTolerances.mutate({
        matchPriceTolerancePercent: pricePercent.trim() === '' ? null : percentToFraction(pricePercent.trim()),
        matchPriceToleranceAbsolute: priceAbsolute.trim() === '' ? null : priceAbsolute.trim(),
        matchQuantityTolerancePercent: quantityPercent.trim() === '' ? null : percentToFraction(quantityPercent.trim()),
      });
      setData(result);
      setSaved(true);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Could not save settings.';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Settings" />
        <TeamPanel />
        <SessionsPanel />
        <StoresPanel />
        <NotificationPreferencesPanel />
        <ThresholdTuningPanel />
        <ActionRatePanel />
        <Card>
          <LoadingState />
        </Card>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="Settings" />
        <TeamPanel />
        <SessionsPanel />
        <StoresPanel />
        <NotificationPreferencesPanel />
        <ThresholdTuningPanel />
        <ActionRatePanel />
        <ErrorNotice>{error}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Your team, stores, notifications, and how we check invoices." />
      <TeamPanel />
      <SessionsPanel />
      <StoresPanel />
      <NotificationPreferencesPanel />
      <ThresholdTuningPanel />
      <ActionRatePanel />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card className="p-6">
        <h2 className="mb-1 text-sm font-semibold text-content">Three-way match tolerances</h2>
        <p className="mb-4 text-sm text-content-subtle">
          A price or quantity difference within these tolerances is treated as clean, not flagged as
          a variance — avoids alert fatigue on cents. Leave a field blank to use the default.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Price can be off by (%)" hint={`Default ${DEFAULT_PRICE_PERCENT_LABEL} — enter 2 for 2%`}>
            <Input
              value={pricePercent}
              onChange={(e) => setPricePercent(e.target.value)}
              placeholder="2"
              inputMode="decimal"
            />
          </Field>
          <Field label="Or off by this amount" hint={`In your currency — default ${DEFAULT_PRICE_ABSOLUTE_LABEL}`}>
            <Input
              value={priceAbsolute}
              onChange={(e) => setPriceAbsolute(e.target.value)}
              placeholder="5.00"
              inputMode="decimal"
            />
          </Field>
          <Field label="Quantity can be off by (%)" hint={`Default ${DEFAULT_QUANTITY_PERCENT_LABEL} — enter 2 for 2%`}>
            <Input
              value={quantityPercent}
              onChange={(e) => setQuantityPercent(e.target.value)}
              placeholder="2"
              inputMode="decimal"
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button type="button" variant="primary" disabled={saving} onClick={save}>
            Save
          </Button>
          {saved && <span className="text-sm text-positive">Saved.</span>}
        </div>
      </Card>
    </>
  );
}
