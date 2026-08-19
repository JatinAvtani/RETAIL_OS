import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSquareCatalog, type SquareOAuthConfig } from './square';

const sandboxConfig: SquareOAuthConfig = {
  applicationId: 'sq0idp-test-app-id',
  applicationSecret: 'sq0csp-test-secret',
  redirectUri: 'http://localhost:3001/integrations/square/callback',
  environment: 'sandbox',
};

/**
 * `fetchSquareCatalog` fixtures mirror Square's REAL wire shape, researched directly
 * against Square's `SearchCatalogObjects`/`CatalogObject`/`CatalogItemVariation` reference docs
 * (not guessed) — `objects` (not `items`), `item_data.categories[]` (not the deprecated
 * `category_id`), `is_deleted` on the object wrapper (not nested), and `price_money` genuinely
 * ABSENT (not null, not zero) when `pricing_type` is `VARIABLE_PRICING`.
 */
describe('fetchSquareCatalog', () => {
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

  it('parses a priced item with one variation, converting minor-unit cents to a decimal string', async () => {
    mockResponse({
      objects: [
        {
          id: 'ITEM-1',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Cappuccino',
            categories: [{ id: 'CAT-DRINKS' }],
            variations: [
              {
                id: 'VAR-1',
                type: 'ITEM_VARIATION',
                is_deleted: false,
                item_variation_data: {
                  name: 'Regular',
                  sku: 'CAPP-REG',
                  pricing_type: 'FIXED_PRICING',
                  price_money: { amount: 450, currency: 'USD' },
                },
              },
            ],
          },
        },
      ],
    });

    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.externalId).toBe('ITEM-1');
    expect(item.name).toBe('Cappuccino');
    expect(item.isDeleted).toBe(false);
    expect(item.category).toBe('CAT-DRINKS');
    expect(item.variations).toHaveLength(1);
    expect(item.variations[0]).toEqual({
      externalId: 'VAR-1',
      name: 'Regular',
      sku: 'CAPP-REG',
      price: { amount: '4.50', currency: 'USD' },
    });
  });

  it('a VARIABLE_PRICING variation has no price at all — undefined, never 0 (I7)', async () => {
    mockResponse({
      objects: [
        {
          id: 'ITEM-2',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Custom Cake',
            variations: [
              {
                id: 'VAR-2',
                type: 'ITEM_VARIATION',
                is_deleted: false,
                item_variation_data: { name: 'Regular', pricing_type: 'VARIABLE_PRICING' },
              },
            ],
          },
        },
      ],
    });

    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');
    expect(result.items[0]!.variations[0]!.price).toBeUndefined();
  });

  it('is_deleted surfaces on the returned item, not silently dropped', async () => {
    mockResponse({
      objects: [
        {
          id: 'ITEM-3',
          type: 'ITEM',
          is_deleted: true,
          item_data: { name: 'Discontinued Item', variations: [] },
        },
      ],
    });

    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');
    expect(result.items[0]!.isDeleted).toBe(true);
  });

  it('an item with multiple variations returns one entry per variation', async () => {
    mockResponse({
      objects: [
        {
          id: 'ITEM-4',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Latte',
            variations: [
              {
                id: 'VAR-4A',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Small', pricing_type: 'FIXED_PRICING', price_money: { amount: 400, currency: 'USD' } },
              },
              {
                id: 'VAR-4B',
                type: 'ITEM_VARIATION',
                item_variation_data: { name: 'Large', pricing_type: 'FIXED_PRICING', price_money: { amount: 550, currency: 'USD' } },
              },
            ],
          },
        },
      ],
    });

    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');
    expect(result.items[0]!.variations).toHaveLength(2);
    expect(result.items[0]!.variations.map((v) => v.externalId)).toEqual(['VAR-4A', 'VAR-4B']);
  });

  it('forwards the cursor field from the response and includes it in a subsequent request', async () => {
    mockResponse({ objects: [], cursor: 'opaque-next-page-cursor' });

    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');
    expect(result.nextCursor).toBe('opaque-next-page-cursor');

    mockResponse({ objects: [] });
    await fetchSquareCatalog(sandboxConfig, 'test-access-token', result.nextCursor);

    const secondCallBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]![1].body as string
    );
    expect(secondCallBody.cursor).toBe('opaque-next-page-cursor');
  });

  it('a final page with no cursor in the response leaves nextCursor undefined', async () => {
    mockResponse({ objects: [] });
    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');
    expect(result.nextCursor).toBeUndefined();
  });

  it('requests include_deleted_objects and object_types: ITEM, per Square’s documented shape', async () => {
    mockResponse({ objects: [] });
    await fetchSquareCatalog(sandboxConfig, 'test-access-token');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe('/v2/catalog/search-catalog-objects');
    const body = JSON.parse(call[1].body as string);
    expect(body.object_types).toEqual(['ITEM']);
    expect(body.include_deleted_objects).toBe(true);
  });

  it('throws on a non-ok response rather than silently returning an empty catalog', async () => {
    mockResponse({ errors: [{ code: 'UNAUTHORIZED' }] }, 401);
    await expect(fetchSquareCatalog(sandboxConfig, 'bad-token')).rejects.toThrow('Square catalog fetch failed: 401');
  });

  it('an item or variation missing its required name field is skipped, not thrown', async () => {
    mockResponse({
      objects: [
        { id: 'ITEM-NO-NAME', type: 'ITEM', is_deleted: false, item_data: { variations: [] } },
        {
          id: 'ITEM-5',
          type: 'ITEM',
          is_deleted: false,
          item_data: {
            name: 'Valid Item',
            variations: [{ id: 'VAR-NO-NAME', type: 'ITEM_VARIATION', item_variation_data: { pricing_type: 'FIXED_PRICING' } }],
          },
        },
      ],
    });

    const result = await fetchSquareCatalog(sandboxConfig, 'test-access-token');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.externalId).toBe('ITEM-5');
    expect(result.items[0]!.variations).toHaveLength(0);
  });
});
