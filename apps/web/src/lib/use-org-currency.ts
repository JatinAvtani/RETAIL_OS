'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Module-level cache: the org's base currency changes at signup and essentially never again, so
 * one fetch per page-load session is plenty — every table cell re-fetching it would be absurd.
 * `null` while loading or on failure: callers render the amount without a currency label rather
 * than guessing one (a wrong currency symbol is a wrong number in the reader's head — this repo
 * has a genuine hardcoded-currency history).
 */
let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

const fetchCurrency = (): Promise<string | null> => {
  if (cached !== null) return Promise.resolve(cached);
  inflight ??= trpc.settings.organizationProfile
    .query()
    .then((profile) => {
      cached = profile.baseCurrency;
      return cached;
    })
    .catch(() => {
      inflight = null;
      return null;
    });
  return inflight;
};

export const useOrgCurrency = (): string | null => {
  const [currency, setCurrency] = useState<string | null>(cached);

  useEffect(() => {
    if (currency !== null) return;
    let cancelled = false;
    fetchCurrency().then((result) => {
      if (!cancelled && result !== null) setCurrency(result);
    });
    return () => {
      cancelled = true;
    };
  }, [currency]);

  return currency;
};
