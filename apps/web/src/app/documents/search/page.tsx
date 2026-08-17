'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { Badge, Card, EmptyState, ErrorNotice, Input, LoadingState, PageHeader, Table, Th, Td, Tr } from '@/components/ui';

type SearchResult = Awaited<ReturnType<typeof trpc.search.documents.query>>;

/**
 * 009-18's real UI consumer — `search.documents` shipped with zero `apps/web` page in its own
 * session (confirmed as separate, deferred UI work at the time; the command palette already covers
 * quick lookup via `search.global`, but has no room to show WHICH search mode ran or a longer
 * result list). This page is that dedicated surface: a plain search box, a real mode indicator
 * (`Lexical` vs. `Hybrid` — spec 11 §11.5's own routing decision made visible, not hidden), and a
 * full result list linking to each document's real review page.
 */
export default function DocumentsSearchPage() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchedOnce, setSearchedOnce] = useState(false);

  const runSearch = (q: string) => {
    if (q.trim().length === 0) return;
    setLoading(true);
    setError(null);
    setSearchedOnce(true);
    trpc.search.documents
      .query({ query: q.trim(), limit: 20 })
      .then(setResult)
      .catch(() => setError('Could not search documents.'))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <PageHeader
        title="Search documents"
        description="Find an invoice by number, supplier, or a natural-language description of what it's about — a longer, conceptual question searches by meaning, not just matching words."
      />

      <Card className="mb-6">
        <form
          className="flex items-center gap-2 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. INV-2024-8891, or “invoices where flour prices went up”"
            className="flex-1"
            autoFocus
          />
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            disabled={query.trim().length === 0 || loading}
          >
            Search
          </button>
        </form>
      </Card>

      {error && <ErrorNotice>{error}</ErrorNotice>}
      {loading && <LoadingState />}

      {!loading && !error && searchedOnce && result && (
        <Card>
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <p className="text-sm text-content-muted">
              {result.results.length} result{result.results.length === 1 ? '' : 's'} for &ldquo;{result.query}&rdquo;
            </p>
            <Badge tone={result.mode === 'hybrid' ? 'positive' : 'neutral'}>
              {result.mode === 'hybrid' ? 'Hybrid (meaning + text)' : 'Lexical (text match)'}
            </Badge>
          </div>
          {result.results.length === 0 ? (
            <EmptyState
              title="No matching documents"
              hint={
                result.mode === 'lexical'
                  ? 'Try a document number, supplier name, or a longer natural-language question.'
                  : 'Nothing matched by meaning either — try different wording.'
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Document</Th>
                  <Th>Supplier</Th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      <Link href={`/documents/${r.id}`} className="font-medium text-accent hover:underline">
                        {r.title}
                      </Link>
                    </Td>
                    <Td className="text-content-muted">{r.subtitle ?? '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {!searchedOnce && (
        <Card>
          <EmptyState title="Search for a document" hint="Try a document number, supplier name, or a longer question about what an invoice covers." />
        </Card>
      )}
    </>
  );
}
