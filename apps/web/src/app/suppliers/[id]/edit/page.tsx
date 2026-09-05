'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '@/lib/trpc';
import { Button, Card, ErrorNotice, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui';

type Contact = { name: string; email?: string; phone?: string; role?: string };

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
] as const;

const emptyContact = (): Contact => ({ name: '', email: '', phone: '', role: '' });

export default function EditSupplierPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();

  const [name, setName] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [paymentTerms, setPaymentTerms] = useState('');
  const [leadTimeDaysContracted, setLeadTimeDaysContracted] = useState('');
  const [leadTimeDaysMeasured, setLeadTimeDaysMeasured] = useState<number | null>(null);
  const [deliveryDays, setDeliveryDays] = useState<number[]>([]);
  const [orderCutoffTime, setOrderCutoffTime] = useState('');
  const [minOrderValue, setMinOrderValue] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    trpc.suppliers.get
      .query({ id: params.id })
      .then((supplier) => {
        setName(supplier.name);
        setStatus(supplier.status);
        setContacts((supplier.contacts as Contact[] | null) ?? []);
        setPaymentTerms(supplier.paymentTerms ?? '');
        setLeadTimeDaysContracted(
          supplier.leadTimeDaysContracted !== null ? String(supplier.leadTimeDaysContracted) : ''
        );
        setLeadTimeDaysMeasured(supplier.leadTimeDaysMeasured);
        setDeliveryDays(supplier.deliveryDays ?? []);
        setOrderCutoffTime(supplier.orderCutoffTime ?? '');
        setMinOrderValue(supplier.minOrderValue ?? '');
      })
      .catch(() => setError('Could not load supplier.'))
      .finally(() => setLoading(false));
  }, [params.id]);

  const toggleDeliveryDay = (day: number) => {
    setDeliveryDays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()
    );
  };

  const updateContact = (index: number, patch: Partial<Contact>) => {
    setContacts((current) => current.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const removeContact = (index: number) => {
    setContacts((current) => current.filter((_, i) => i !== index));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);

    try {
      // Blank rows/fields are dropped rather than sent as empty strings — an empty email on a
      // contact who has none is a real "no value," never a fabricated one (I7's spirit applied to
      // free-text UI fields, not just business numbers).
      const cleanedContacts = contacts
        .filter((c) => c.name.trim() !== '')
        .map((c) => ({
          name: c.name.trim(),
          ...(c.email?.trim() && { email: c.email.trim() }),
          ...(c.phone?.trim() && { phone: c.phone.trim() }),
          ...(c.role?.trim() && { role: c.role.trim() }),
        }));

      await trpc.suppliers.update.mutate({
        id: params.id,
        name,
        status,
        contacts: cleanedContacts.length > 0 ? cleanedContacts : null,
        paymentTerms: paymentTerms.trim() === '' ? null : paymentTerms.trim(),
        leadTimeDaysContracted: leadTimeDaysContracted.trim() === '' ? null : Number(leadTimeDaysContracted),
        deliveryDays: deliveryDays.length > 0 ? deliveryDays : null,
        orderCutoffTime: orderCutoffTime.trim() === '' ? null : orderCutoffTime.trim(),
        minOrderValue: minOrderValue.trim() === '' ? null : minOrderValue.trim(),
      });
      setSaved(true);
    } catch (err) {
      const message = err instanceof TRPCClientError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingState />;

  return (
    <>
      <PageHeader
        title={name || 'Edit supplier'}
        actions={
          <Link href="/suppliers">
            <Button variant="ghost">Back to suppliers</Button>
          </Link>
        }
      />

      <Card className="max-w-3xl p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {saved && (
            <div className="rounded-card border border-positive/30 bg-positive-soft px-4 py-3 text-sm text-positive">
              Changes saved.
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name">
              <Input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </Select>
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-content">Contacts</h3>
              <Button type="button" variant="ghost" onClick={() => setContacts((c) => [...c, emptyContact()])}>
                Add contact
              </Button>
            </div>
            {contacts.length === 0 && <p className="text-sm text-content-subtle">No contacts yet — add one above.</p>}
            <div className="space-y-3">
              {contacts.map((contact, index) => (
                <div key={index} className="grid gap-3 rounded-card border border-border p-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                  <Input
                    placeholder="Name"
                    value={contact.name}
                    onChange={(e) => updateContact(index, { name: e.target.value })}
                  />
                  <Input
                    type="email"
                    placeholder="Email"
                    value={contact.email ?? ''}
                    onChange={(e) => updateContact(index, { email: e.target.value })}
                  />
                  <Input
                    placeholder="Phone"
                    value={contact.phone ?? ''}
                    onChange={(e) => updateContact(index, { phone: e.target.value })}
                  />
                  <Input
                    placeholder="Role"
                    value={contact.role ?? ''}
                    onChange={(e) => updateContact(index, { role: e.target.value })}
                  />
                  <Button type="button" variant="danger" onClick={() => removeContact(index)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Payment terms" hint="e.g. Net 30">
              <Input type="text" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
            </Field>
            <Field label="Minimum order value">
              <Input
                value={minOrderValue}
                onChange={(e) => setMinOrderValue(e.target.value)}
                placeholder="250.00"
                inputMode="decimal"
              />
            </Field>
            <Field label="Lead time — contracted (days)">
              <Input
                type="number"
                min="0"
                value={leadTimeDaysContracted}
                onChange={(e) => setLeadTimeDaysContracted(e.target.value)}
              />
            </Field>
            <Field label="Lead time — measured (days)" hint="Derived from real receipts, not editable here.">
              <Input
                type="text"
                value={leadTimeDaysMeasured !== null ? `${leadTimeDaysMeasured}d` : 'Not known'}
                disabled
              />
            </Field>
            <Field label="Order cut-off time" hint="24-hour, e.g. 14:00">
              <Input
                type="time"
                value={orderCutoffTime}
                onChange={(e) => setOrderCutoffTime(e.target.value)}
              />
            </Field>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-content">Delivery days</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => toggleDeliveryDay(day.value)}
                  className={
                    deliveryDays.includes(day.value)
                      ? 'rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground'
                      : 'rounded-full border border-border-strong px-3 py-1.5 text-sm text-content-muted hover:bg-surface-sunken'
                  }
                >
                  {day.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-border pt-5">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push('/suppliers')}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
