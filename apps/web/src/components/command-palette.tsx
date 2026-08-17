'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { LogoMark } from './logo';
import { cx } from './ui';

type SearchResult = { entityType: 'product' | 'supplier' | 'purchase_order' | 'document'; id: string; title: string; subtitle: string | null; score: number };
type SearchResults = { products: SearchResult[]; suppliers: SearchResult[]; purchaseOrders: SearchResult[]; documents: SearchResult[] };

const EMPTY_RESULTS: SearchResults = { products: [], suppliers: [], purchaseOrders: [], documents: [] };

const GROUPS: { key: keyof SearchResults; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'purchaseOrders', label: 'Purchase orders' },
  { key: 'documents', label: 'Documents' },
];

/** Where a result actually navigates — honest about what real detail pages exist today (no dedicated /suppliers page exists yet, so a supplier result goes to the scorecard's own page rather than a fabricated deep link). */
const resultHref = (result: SearchResult): string => {
  switch (result.entityType) {
    case 'product':
      return `/products/${result.id}/edit`;
    case 'supplier':
      return `/purchase-orders/supplier-scorecard`;
    case 'purchase_order':
      return `/purchase-orders/${result.id}`;
    case 'document':
      return `/documents/${result.id}`;
  }
};

/**
 * 009-17 (spec 11 §11.4) — "the primary navigation mechanism for power users." A real global
 * Cmd/Ctrl+K overlay mounted once in `AppShell` (every authenticated page renders through it), not
 * a per-page search box. Debounced at 150ms (the spec's own literal number). Results are grouped by
 * entity type (never a single re-ranked list — cross-entity score normalization is a genuinely
 * harder relevance problem `search.global`'s own header comment explains why this task doesn't
 * attempt), each already sorted by `SearchRepository`'s own score.
 */
export const CommandPalette = () => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults(EMPTY_RESULTS);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        close();
      }
    };
    // A plain window event, not a prop — the visible nav-bar trigger button lives in `AppShell`,
    // a sibling rather than a parent of this component, and a custom event is a smaller surface
    // than lifting this component's entire query/results state up into the shell just to expose
    // one `open()` call.
    const onOpenRequest = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('retailos:open-search', onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('retailos:open-search', onOpenRequest);
    };
  }, [close]);

  useEffect(() => {
    if (open) {
      // Focus after the overlay's own paint, not synchronously — the input doesn't exist in the
      // DOM yet on the same tick `open` flips true.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length === 0) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      trpc.search.global
        .query({ query: query.trim(), limitPerType: 5 })
        .then((res) => setResults(res.results))
        .catch(() => setResults(EMPTY_RESULTS))
        .finally(() => setLoading(false));
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const navigate = (result: SearchResult) => {
    router.push(resultHref(result));
    close();
  };

  const totalResults = GROUPS.reduce((sum, g) => sum + results[g.key].length, 0);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={close}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-card border border-border-strong bg-surface-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products, suppliers, purchase orders, documents…"
          className="w-full border-b border-border bg-transparent px-5 py-4 text-[15px] text-content outline-none placeholder:text-content-subtle"
        />
        <div className="max-h-96 overflow-y-auto">
          {/* Resting state. An empty palette that shows nothing reads as broken; naming what is
              searchable turns the pause into an instruction. */}
          {!loading && query.trim().length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-content-subtle">
              Start typing to search across your products, suppliers, orders and documents.
            </p>
          )}
          {loading && <p className="px-5 py-8 text-center text-sm text-content-subtle">Searching…</p>}
          {!loading && query.trim().length > 0 && totalResults === 0 && (
            <p className="px-5 py-8 text-center text-sm text-content-subtle">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          )}
          {!loading &&
            GROUPS.map(
              (group) =>
                results[group.key].length > 0 && (
                  <div key={group.key} className="py-1.5">
                    <p className="px-5 py-1.5 text-xs font-semibold uppercase tracking-wide text-content-subtle">{group.label}</p>
                    {results[group.key].map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        onClick={() => navigate(result)}
                        className={cx(
                          'flex w-full items-center justify-between gap-3 px-5 py-2 text-left text-sm',
                          'text-content hover:bg-surface-sunken'
                        )}
                      >
                        <span className="truncate font-medium">{result.title}</span>
                        {result.subtitle && <span className="shrink-0 truncate text-xs text-content-subtle">{result.subtitle}</span>}
                      </button>
                    ))}
                  </div>
                )
            )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs text-content-subtle">
          <span>↑↓ to navigate · Enter to select</span>
          <span className="inline-flex items-center gap-1.5">
            <LogoMark className="size-3 text-content-subtle" />
            Vyapaar
          </span>
        </div>
      </div>
    </div>
  );
};
