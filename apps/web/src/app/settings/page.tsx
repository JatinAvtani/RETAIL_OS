'use client';

import { useCallback, useEffect, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { shiftDecimalPoint } from '@/lib/format';
import { Badge, Button, Card, CardHeader, ErrorNotice, Field, Input, LoadingState, PageHeader, Select, Table, Th, Td, Tr } from '@/components/ui';

type Tolerances = Awaited<ReturnType<typeof trpc.settings.getMatchTolerances.query>>;
type Member = Awaited<ReturnType<typeof trpc.invitations.listMembers.query>>[number];
type PendingInvitation = Awaited<ReturnType<typeof trpc.invitations.listPending.query>>[number];

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
      setDevToken(result._devOnlyInvitationToken);
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
        <ErrorNotice>{error}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Your team and how we check invoices." />
      <TeamPanel />

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
