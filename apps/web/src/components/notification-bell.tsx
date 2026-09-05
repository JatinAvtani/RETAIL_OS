'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { cx } from './ui';

type Notification = Awaited<ReturnType<typeof trpc.notifications.list.query>>[number];

const SEVERITY_DOT: Record<string, string> = {
  CRITICAL: 'bg-danger',
  HIGH: 'bg-danger',
  MEDIUM: 'bg-warning',
  INFO: 'bg-content-subtle',
};

/**
 * The epic's first always-visible surface — lives in `app-shell.tsx`'s header, matching
 * `ThemeToggle`'s own "present on every page" placement. Independently resolves the caller's
 * first accessible store (own `stores.list` call, not `useStores()`) since the header renders on
 * pages that never mount that hook — a header-level component cannot depend on a specific page's
 * own state.
 *
 * Polls `unreadCount` every 30s rather than a live push channel — this codebase has no
 * WebSocket/SSE infrastructure anywhere, and a 30s badge-staleness window is a reasonable
 * trade-off for the first version of this surface (a real push mechanism is future scope, not a
 * silent gap: the badge is honestly just "as of the last poll," not claimed to be live).
 */
export const NotificationBell = () => {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    trpc.stores.list
      .query()
      .then((stores) => {
        if (stores.length > 0 && stores[0]) setStoreId(stores[0].id);
      })
      .catch(() => {
        // No accessible store — nothing to show; the bell simply stays quiet rather than erroring
        // on every page load for a caller with zero store access.
      });
  }, []);

  useEffect(() => {
    if (!storeId) return;
    const poll = () => {
      trpc.notifications.unreadCount
        .query({ storeId })
        .then((result) => setUnreadCount(result.count))
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, [storeId]);

  useEffect(() => {
    if (!open || !storeId) return;
    setError(null);
    trpc.notifications.list
      .query({ storeId })
      .then(setNotifications)
      .catch(() => setError('Could not load notifications.'));
  }, [open, storeId]);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const markRead = (id: string) => {
    trpc.notifications.markRead
      .mutate({ id })
      .then(() => {
        setUnreadCount((count) => (count !== null ? Math.max(0, count - 1) : count));
        setNotifications((list) => list?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
      })
      .catch(() => {});
  };

  if (!storeId) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls="notification-panel"
        className="relative rounded-control px-2.5 py-1 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4.5"
        >
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 21h4" />
        </svg>
        {unreadCount !== null && unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 font-mono text-[10px] font-semibold text-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          id="notification-panel"
          role="menu"
          aria-label="Notifications"
          className="animate-dropdown-in absolute right-0 z-30 mt-2 w-96 rounded-card border border-border bg-surface-raised shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold text-content">Notifications</span>
            <Link
              href="/notifications"
              className="text-xs font-medium text-accent hover:underline"
              onClick={() => setOpen(false)}
            >
              View all
            </Link>
          </div>

          {error && <p className="px-4 py-6 text-center text-sm text-content-muted">{error}</p>}

          {!error && notifications === null && (
            <p className="px-4 py-6 text-center text-sm text-content-muted">Loading…</p>
          )}

          {!error && notifications !== null && notifications.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-content-muted">No notifications.</p>
          )}

          {!error && notifications !== null && notifications.length > 0 && (
            <ul className="max-h-96 overflow-y-auto">
              {notifications.slice(0, 10).map((notification) => (
                <li
                  key={notification.id}
                  className={cx(
                    'border-b border-border px-4 py-2.5 last:border-b-0',
                    !notification.readAt && 'bg-accent-soft/40'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => !notification.readAt && markRead(notification.id)}
                    className="flex w-full items-start gap-2 text-left"
                  >
                    <span
                      aria-hidden="true"
                      className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', SEVERITY_DOT[notification.severity] ?? 'bg-content-subtle')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-content">{notification.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-content-muted">{notification.body}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
