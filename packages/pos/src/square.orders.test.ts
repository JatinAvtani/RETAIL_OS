import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSquareOrders, type SquareOAuthConfig } from './square';

const sandboxConfig: SquareOAuthConfig = {
  applicationId: 'sq0idp-test-app-id',
  applicationSecret: 'sq0csp-test-secret',
  redirectUri: 'http://localhost:3001/integrations/square/callback',
  environment: 'sandbox',
};

const SINCE = new Date('2026-08-01T00:00:00Z');
const LOCATION_ID = 'LOC-1';

/**
 * 006-05: `fetchSquareOrders` fixtures mirror Square's REAL Orders API wire shape, researched
 * directly against Square's `SearchOrders`/`Order` reference docs (not guessed) — `orders` (not
 * `items`/`results`), `state` has FOUR real values (OPEN/DRAFT/COMPLETED/CANCELED, not three), money
 * fields are integer minor-unit cents (converted via Decimal, matching `fetchSquareCatalog`'s own
 * convention), and `line_items[].catalog_object_id` is the join key back to `pos_items.external_id`.
 */
describe('fetchSquareOrders', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockResponse = (body: unknown, status = 200) => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    );
  };

  it('maps a COMPLETED order into a single-check ExternalTransaction with correct decimal amounts', async () => {
    mockResponse({
      orders: [
        {
          id: 'ORDER-1',
          location_id: LOCATION_ID,
          created_at: '2026-08-02T12:00:00Z',
          updated_at: '2026-08-02T12:05:00Z',
          state: 'COMPLETED',
          line_items: [
            {
              uid: 'LINE-1',
              catalog_object_id: 'VAR-1',
              name: 'Cappuccino',
              quantity: '2',
              base_price_money: { amount: 450, currency: 'USD' },
              total_discount_money: { amount: 0, currency: 'USD' },
              total_money: { amount: 900, currency: 'USD' },
            },
          ],
          total_money: { amount: 900, currency: 'USD' },
          total_tax_money: { amount: 72, currency: 'USD' },
          total_discount_money: { amount: 0, currency: 'USD' },
        },
      ],
    });

    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);

    expect(result.items).toHaveLength(1);
    const tx = result.items[0]!;
    expect(tx.externalId).toBe('ORDER-1');
    expect(tx.locationExternalId).toBe(LOCATION_ID);
    expect(tx.status).toBe('completed');
    expect(tx.occurredAt).toEqual(new Date('2026-08-02T12:00:00Z'));
    expect(tx.checks).toHaveLength(1);

    const check = tx.checks[0]!;
    expect(check.total).toEqual({ amount: '9.00', currency: 'USD' });
    expect(check.tax).toEqual({ amount: '0.72', currency: 'USD' });
    expect(check.lines).toHaveLength(1);
    expect(check.lines[0]).toEqual({
      externalId: 'LINE-1',
      posItemExternalId: 'VAR-1',
      name: 'Cappuccino',
      quantity: '2',
      unitPrice: { amount: '4.50', currency: 'USD' },
      discount: { amount: '0.00', currency: 'USD' },
      lineTotal: { amount: '9.00', currency: 'USD' },
      modifiers: [],
      voided: false,
    });
  });

  it('maps a CANCELED order to status "voided"', async () => {
    mockResponse({
      orders: [
        {
          id: 'ORDER-2',
          location_id: LOCATION_ID,
          created_at: '2026-08-02T12:00:00Z',
          state: 'CANCELED',
          line_items: [],
          total_money: { amount: 0, currency: 'USD' },
        },
      ],
    });

    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
    expect(result.items[0]!.status).toBe('voided');
  });

  it('an OPEN or DRAFT order is skipped entirely — not a final sale yet', async () => {
    mockResponse({
      orders: [
        { id: 'ORDER-OPEN', location_id: LOCATION_ID, created_at: '2026-08-02T12:00:00Z', state: 'OPEN', line_items: [] },
        { id: 'ORDER-DRAFT', location_id: LOCATION_ID, created_at: '2026-08-02T12:00:00Z', state: 'DRAFT', line_items: [] },
      ],
    });

    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
    expect(result.items).toHaveLength(0);
  });

  it('a line item missing a required field is skipped, not thrown, while the order itself is still mapped', async () => {
    mockResponse({
      orders: [
        {
          id: 'ORDER-3',
          location_id: LOCATION_ID,
          created_at: '2026-08-02T12:00:00Z',
          state: 'COMPLETED',
          line_items: [
            { uid: 'LINE-NO-CATALOG-ID', name: 'Missing catalog_object_id', quantity: '1', total_money: { amount: 100, currency: 'USD' } },
            {
              uid: 'LINE-OK',
              catalog_object_id: 'VAR-OK',
              name: 'Valid Line',
              quantity: '1',
              base_price_money: { amount: 300, currency: 'USD' },
              total_money: { amount: 300, currency: 'USD' },
            },
          ],
          total_money: { amount: 300, currency: 'USD' },
        },
      ],
    });

    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
    expect(result.items[0]!.checks[0]!.lines).toHaveLength(1);
    expect(result.items[0]!.checks[0]!.lines[0]!.externalId).toBe('LINE-OK');
  });

  it('requests location_ids, the updated_at date_time_filter matching "since", and state_filter for COMPLETED/CANCELED only', async () => {
    mockResponse({ orders: [] });
    await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe('/v2/orders/search');
    const body = JSON.parse(call[1].body as string);
    expect(body.location_ids).toEqual([LOCATION_ID]);
    expect(body.query.filter.date_time_filter.updated_at.start_at).toBe(SINCE.toISOString());
    expect(body.query.filter.state_filter.states).toEqual(['COMPLETED', 'CANCELED']);
    expect(body.query.sort.sort_field).toBe('UPDATED_AT');
  });

  it('forwards the cursor field from the response and includes it in a subsequent request', async () => {
    mockResponse({ orders: [], cursor: 'opaque-orders-cursor' });
    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
    expect(result.nextCursor).toBe('opaque-orders-cursor');

    mockResponse({ orders: [] });
    await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE, result.nextCursor);

    const secondCallBody = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]![1].body as string);
    expect(secondCallBody.cursor).toBe('opaque-orders-cursor');
  });

  it('a final page with no cursor leaves nextCursor undefined', async () => {
    mockResponse({ orders: [] });
    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
    expect(result.nextCursor).toBeUndefined();
  });

  it('throws on a non-ok response rather than silently returning an empty page', async () => {
    mockResponse({ errors: [{ code: 'UNAUTHORIZED' }] }, 401);
    await expect(fetchSquareOrders(sandboxConfig, 'bad-token', LOCATION_ID, SINCE)).rejects.toThrow('Square orders fetch failed: 401');
  });

  it('an order missing a required field (no id, no created_at, or an unrecognized state) is skipped, not thrown', async () => {
    mockResponse({
      orders: [
        { location_id: LOCATION_ID, created_at: '2026-08-02T12:00:00Z', state: 'COMPLETED', line_items: [] }, // no id
        { id: 'ORDER-NO-DATE', location_id: LOCATION_ID, state: 'COMPLETED', line_items: [] }, // no created_at
        { id: 'ORDER-BAD-STATE', location_id: LOCATION_ID, created_at: '2026-08-02T12:00:00Z', state: 'SOMETHING_NEW', line_items: [] },
      ],
    });

    const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
    expect(result.items).toHaveLength(0);
  });

  /**
   * 006-08: refunds live in the SAME order object's `refunds[]` array, researched directly against
   * Square's Orders API reference. Only `APPROVED` entries count — `PENDING`/`REJECTED`/`FAILED`
   * refund attempts must never be treated as money that actually left (I7).
   */
  describe('refunds', () => {
    it('an order with no refunds[] at all has refundedAmount undefined, never $0.00', async () => {
      mockResponse({ orders: [orderWithRefunds('ORDER-NO-REFUND', 450, undefined)] });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.refundedAmount).toBeUndefined();
      expect(result.items[0]!.status).toBe('completed');
    });

    it('a full APPROVED refund (amount equals the order total) sets status to refunded', async () => {
      mockResponse({
        orders: [orderWithRefunds('ORDER-FULL-REFUND', 450, [{ amount_money: { amount: 450, currency: 'USD' }, status: 'APPROVED' }])],
      });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.status).toBe('refunded');
      expect(result.items[0]!.refundedAmount).toEqual({ amount: '4.50', currency: 'USD' });
    });

    it('a partial APPROVED refund (amount below the order total) keeps status completed, with refundedAmount set', async () => {
      mockResponse({
        orders: [orderWithRefunds('ORDER-PARTIAL-REFUND', 1000, [{ amount_money: { amount: 300, currency: 'USD' }, status: 'APPROVED' }])],
      });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.status).toBe('completed');
      expect(result.items[0]!.refundedAmount).toEqual({ amount: '3.00', currency: 'USD' });
    });

    it('multiple APPROVED refund entries sum together', async () => {
      mockResponse({
        orders: [
          orderWithRefunds('ORDER-MULTI-REFUND', 1000, [
            { amount_money: { amount: 300, currency: 'USD' }, status: 'APPROVED' },
            { amount_money: { amount: 200, currency: 'USD' }, status: 'APPROVED' },
          ]),
        ],
      });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.refundedAmount).toEqual({ amount: '5.00', currency: 'USD' });
    });

    it('a PENDING refund entry does not count toward refundedAmount — money has not actually left', async () => {
      mockResponse({
        orders: [orderWithRefunds('ORDER-PENDING-REFUND', 450, [{ amount_money: { amount: 450, currency: 'USD' }, status: 'PENDING' }])],
      });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.refundedAmount).toBeUndefined();
      expect(result.items[0]!.status).toBe('completed');
    });

    it('a REJECTED or FAILED refund entry does not count toward refundedAmount', async () => {
      mockResponse({
        orders: [
          orderWithRefunds('ORDER-REJECTED-REFUND', 450, [
            { amount_money: { amount: 450, currency: 'USD' }, status: 'REJECTED' },
            { amount_money: { amount: 450, currency: 'USD' }, status: 'FAILED' },
          ]),
        ],
      });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.refundedAmount).toBeUndefined();
    });

    it('a mix of APPROVED and PENDING sums only the APPROVED entry', async () => {
      mockResponse({
        orders: [
          orderWithRefunds('ORDER-MIXED-REFUND', 1000, [
            { amount_money: { amount: 300, currency: 'USD' }, status: 'APPROVED' },
            { amount_money: { amount: 200, currency: 'USD' }, status: 'PENDING' },
          ]),
        ],
      });
      const result = await fetchSquareOrders(sandboxConfig, 'token', LOCATION_ID, SINCE);
      expect(result.items[0]!.refundedAmount).toEqual({ amount: '3.00', currency: 'USD' });
      expect(result.items[0]!.status).toBe('completed'); // partial, not full
    });
  });
});

const orderWithRefunds = (
  externalId: string,
  totalCents: number,
  refunds: Array<{ amount_money?: { amount?: number; currency?: string }; status?: string }> | undefined
) => ({
  id: externalId,
  location_id: LOCATION_ID,
  created_at: '2026-08-02T12:00:00Z',
  state: 'COMPLETED',
  line_items: [],
  total_money: { amount: totalCents, currency: 'USD' },
  ...(refunds !== undefined ? { refunds } : {}),
});
