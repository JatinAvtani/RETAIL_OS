'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { ThemeToggle } from './theme-toggle';
import { CommandPalette } from './command-palette';
import { NotificationBell } from './notification-bell';
import { Logo } from './logo';
import { cx } from './ui';

/**
 * Grouped, not a flat list. Fifteen equal-weight links in one row (the previous top-bar nav) both
 * overflowed and flattened a real hierarchy — "Overview" and "POS mapping" are not peers; one is
 * checked every shift, the other twice a year. The group names describe what the operator is doing,
 * not which module owns the table: you come here to watch the numbers, look something up in the
 * catalogue, follow stock as it moves, or wire up a connection.
 */
const NAV_GROUPS: { label: string; items: { href: string; label: string }[] }[] = [
  {
    label: 'Watch',
    items: [
      { href: '/dashboard', label: 'Overview' },
      { href: '/first-finding-report', label: 'First finding' },
      { href: '/dashboard/manager', label: 'Manager view' },
      { href: '/purchase-orders/variance-queue', label: 'Variance queue' },
      { href: '/assistant', label: 'Assistant' },
      { href: '/notifications', label: 'Notifications' },
    ],
  },
  {
    label: 'Catalogue',
    items: [
      { href: '/products', label: 'Products' },
      { href: '/categories', label: 'Categories' },
      { href: '/recipes', label: 'Recipes' },
      { href: '/suppliers', label: 'Suppliers' },
    ],
  },
  {
    label: 'Movement',
    items: [
      { href: '/inventory', label: 'Inventory' },
      { href: '/documents', label: 'Documents' },
      { href: '/purchase-orders', label: 'Purchase orders' },
      { href: '/purchase-orders/suggestions', label: 'Reorder suggestions' },
      { href: '/purchase-orders/supplier-scorecard', label: 'Supplier scorecard' },
    ],
  },
  {
    label: 'Connections',
    items: [
      { href: '/integrations', label: 'Integrations' },
      { href: '/pos-items', label: 'POS mapping' },
      { href: '/sales-import', label: 'Sales import' },
    ],
  },
];

const COLLAPSE_KEY = 'retailos-nav-collapsed';

/**
 * Exact match only for the two /dashboard routes — both are real, sibling top-level destinations
 * (Overview vs. Manager view) that share a Next.js layout for AuthGuard rather than being in a
 * parent/child relationship; a prefix match would highlight "Overview" while genuinely on
 * "Manager view". Same reasoning for the three /purchase-orders/* entries — siblings under a path
 * segment that is ALSO a destination now (the PO list), which is why `isActive` additionally needs
 * its most-specific-wins rule below.
 */
const EXACT_MATCH_ONLY = new Set(['/dashboard', '/purchase-orders/suggestions', '/purchase-orders/variance-queue', '/purchase-orders/supplier-scorecard']);

/** Every href any nav item links to — see the most-specific-wins rule in `isActive`. */
const ALL_NAV_HREFS = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)));

/**
 * Most specific wins: `/purchase-orders` is now a real destination (the PO list) AND the path
 * parent of three sibling nav items, so a bare startsWith would light the parent up alongside
 * whichever sibling is exact-active. A prefix match therefore only counts when the pathname is
 * not itself some other nav item's exact destination.
 */
const isActive = (href: string, pathname: string): boolean => {
  if (pathname === href) return true;
  if (EXACT_MATCH_ONLY.has(href)) return false;
  return pathname.startsWith(`${href}/`) && !ALL_NAV_HREFS.has(pathname);
};

/**
 * How wide the content column is, chosen per page rather than globally. One centred `max-w-6xl` for
 * everything was wrong for two of the three archetypes: it wastes exactly the horizontal space a
 * wide table needs, while making a single-column form's eye travel from label to field across dead
 * space.
 *
 * - `dashboard` — a comfortable grid; beyond this tiles stretch into stripes. 1440 rather than
 *                 1280: on the 1690px working area a 1920 monitor leaves beside the sidebar, 1280
 *                 abandoned a third of the screen to margin — dead space that read as an
 *                 unfinished layout, not as restraint. Four tiles at 1440 are ~350px each, still
 *                 tiles, not stripes.
 * - `table`     — full bleed, because columns ARE the content.
 * - `form`      — narrow and left-aligned, so the page doesn't reflow when moving between a table
 *                 and its own edit form.
 */
export type ContentWidth = 'dashboard' | 'table' | 'form';

const CONTENT_WIDTH: Record<ContentWidth, string> = {
  dashboard: 'mx-auto w-full max-w-[1440px]',
  table: 'w-full',
  form: 'w-full max-w-[720px]',
};

/** Path segment → human label for breadcrumbs. A segment not listed here is id-shaped and renders as "Detail". */
const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Overview',
  manager: 'Manager view',
  assistant: 'Assistant',
  products: 'Products',
  categories: 'Categories',
  recipes: 'Recipes',
  suppliers: 'Suppliers',
  inventory: 'Inventory',
  lots: 'Lots',
  movements: 'Movements',
  stocktake: 'Stocktakes',
  waste: 'Log waste',
  documents: 'Documents',
  search: 'Search',
  'purchase-orders': 'Purchase orders',
  new: 'New',
  suggestions: 'Reorder suggestions',
  'supplier-scorecard': 'Supplier scorecard',
  'variance-queue': 'Variance queue',
  'receive-walk-in': 'Receive walk-in',
  receive: 'Receive',
  'invoice-matches': 'Invoice matches',
  integrations: 'Integrations',
  'pos-items': 'POS mapping',
  'sales-import': 'Sales import',
  edit: 'Edit',
  settings: 'Settings',
  notifications: 'Notifications',
  onboarding: 'Get set up',
  'confirm-detected': 'Confirm detected',
  'first-finding-report': 'First finding',
};

/**
 * Crumbs only link where a page actually answers — `/invoice-matches` has no index route, so its
 * crumb is plain text; linking it would be a 404 dressed as a path home.
 */
const LINKABLE_CRUMBS = new Set([
  ...ALL_NAV_HREFS,
  '/products',
  '/suppliers',
  '/recipes',
  '/categories',
  '/inventory/stocktake',
  '/documents',
  '/sales-import',
]);

/** Sibling routes that merely SHARE a path prefix — a breadcrumb would imply a parent/child relationship that doesn't exist. */
const NO_BREADCRUMBS = new Set(['/dashboard/manager']);

/**
 * A deep route's path back out. Derived from the pathname (one rule for all 26 screens, no
 * per-page wiring): each segment maps to its label, id-shaped segments render as "Detail", and
 * the final crumb is the current page — plain text, since the entity's real name is in the
 * PageHeader immediately below. Top-level pages get no breadcrumb; they ARE the top.
 */
const Breadcrumbs = ({ pathname }: { pathname: string }) => {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || NO_BREADCRUMBS.has(pathname)) return null;
  const crumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    return {
      href,
      label: SEGMENT_LABELS[segment] ?? 'Detail',
      isCurrent: index === segments.length - 1,
      isLinkable: LINKABLE_CRUMBS.has(href),
    };
  });
  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-content-muted">
        {crumbs.map((crumb) => (
          <li key={crumb.href} className="flex items-center gap-1.5">
            {crumb !== crumbs[0] && (
              <span aria-hidden="true" className="text-content-subtle">
                /
              </span>
            )}
            {crumb.isCurrent ? (
              <span aria-current="page" className="font-medium text-content">
                {crumb.label}
              </span>
            ) : crumb.isLinkable ? (
              <Link href={crumb.href} className="hover:text-content hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span>{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
};

const NavLinks = ({
  pathname,
  collapsed,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  onNavigate: () => void;
}) => (
  <nav className="flex-1 overflow-y-auto px-2 pt-4 pb-3">
    {NAV_GROUPS.map((group, groupIndex) => (
      <div key={group.label} className={cx('mb-5 last:mb-0', groupIndex > 0 && !collapsed && 'border-t border-border pt-4')}>
        {/* The group heading disappears when collapsed rather than truncating to noise; the icon
            rail is for people who already know the layout and are navigating by position.
            10px + wide tracking + a hairline rule above each group (after the first) is what
            actually separates "this is a section label" from "this is a clickable item" —
            text-xs alone was the same size as the links it was supposed to head, so the two
            read as one flat list. */}
        {!collapsed && (
          <p className="px-2.5 pb-2 text-[11px] font-bold uppercase tracking-widest text-content-muted">
            {group.label}
          </p>
        )}
        <ul className={cx(collapsed && 'border-b border-border pb-2 last:border-b-0')}>
          {group.items.map((item) => {
            const active = isActive(item.href, pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-2.5 rounded-control border-l-2 py-1.5 text-sm transition-colors',
                    collapsed ? 'justify-center px-2' : 'px-2.5',
                    // Ink text on a brass wash plus a solid brass edge, rather than brass text on a
                    // wash: at this size, coloured text on a coloured ground is the weakest of the
                    // available signals.
                    active
                      ? 'border-l-accent bg-accent-soft font-semibold text-content'
                      : 'border-l-transparent text-content-muted hover:bg-surface-sunken hover:text-content'
                  )}
                >
                  {collapsed ? (
                    <span aria-hidden="true" className="font-mono text-xs font-semibold">
                      {item.label.slice(0, 2)}
                    </span>
                  ) : (
                    item.label
                  )}
                  {collapsed && <span className="sr-only">{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </nav>
);

export const AppShell = ({
  children,
  width = 'dashboard',
}: {
  children: ReactNode;
  width?: ContentWidth;
}) => {
  const pathname = usePathname();
  const router = useRouter();
  const [isMac, setIsMac] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setIsMac(navigator.platform.toLowerCase().includes('mac'));
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // A blocked localStorage shouldn't break the nav — it just won't remember the preference.
    }
  }, []);

  // Closing on navigation is what makes the drawer usable; without it the panel stays over the page
  // the user just asked for.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // While the drawer is an overlay (mobile), it behaves as a modal: focus moves into it on open,
  // Tab cycles within it, Escape closes it, and focus lands back on the hamburger that opened it —
  // without the return, closing the drawer dumps a keyboard user at the top of the document.
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const firstLink = asideRef.current?.querySelector<HTMLElement>('a, button');
    firstLink?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        hamburgerRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab' || !asideRef.current) return;
      const focusables = Array.from(
        asideRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // As above — the collapse still applies for this page view.
    }
  };

  const logout = async () => {
    try {
      await trpc.auth.logout.mutate();
    } finally {
      // Bounce regardless — a failed logout call still shouldn't strand the user on an
      // authenticated-looking page.
      router.replace('/login');
    }
  };

  const settingsActive = isActive('/settings', pathname);

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile drawer scrim */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        ref={asideRef}
        id="app-sidebar"
        aria-label="Primary navigation"
        className={cx(
          'flex flex-col border-r border-border bg-surface-raised transition-[width]',
          'fixed inset-y-0 left-0 z-40 w-58 lg:sticky lg:top-0 lg:z-auto lg:h-screen',
          drawerOpen ? 'flex' : 'hidden lg:flex',
          collapsed ? 'lg:w-13' : 'lg:w-58'
        )}
      >
        <div
          className={cx(
            'flex h-12 shrink-0 items-center border-b border-border',
            collapsed ? 'justify-center px-2' : 'gap-2 px-3'
          )}
        >
          <Link href="/dashboard" aria-label="Vyapaar — go to overview">
            <Logo showWordmark={!collapsed} markClassName="size-6" />
          </Link>
        </div>

        <NavLinks pathname={pathname} collapsed={collapsed} onNavigate={() => setDrawerOpen(false)} />

        <div className="shrink-0 border-t border-border px-2 py-2">
          <Link
            href="/settings"
            title={collapsed ? 'Settings' : undefined}
            aria-current={settingsActive ? 'page' : undefined}
            className={cx(
              'flex items-center gap-2.5 rounded-control border-l-2 py-1.5 text-sm transition-colors',
              collapsed ? 'justify-center px-2' : 'px-2.5',
              settingsActive
                ? 'border-l-accent bg-accent-soft font-semibold text-content'
                : 'border-l-transparent text-content-muted hover:bg-surface-sunken hover:text-content'
            )}
          >
            {collapsed ? (
              <>
                <span aria-hidden="true" className="font-mono text-xs font-semibold">
                  Se
                </span>
                <span className="sr-only">Settings</span>
              </>
            ) : (
              'Settings'
            )}
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={cx(
              'mt-1 hidden w-full items-center gap-2.5 rounded-control py-1.5 text-sm text-content-subtle',
              'transition-colors hover:bg-surface-sunken hover:text-content lg:flex',
              collapsed ? 'justify-center px-2' : 'px-2.5'
            )}
          >
            <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
            {!collapsed && 'Collapse'}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-surface-raised/90 backdrop-blur">
          <div className="flex h-12 items-center gap-2 px-4">
            <button
              ref={hamburgerRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              aria-controls="app-sidebar"
              className="rounded-control px-2 py-1 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content lg:hidden"
            >
              <span aria-hidden="true">☰</span>
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event('retailos:open-search'))}
                className="flex items-center gap-2 rounded-control border border-border-strong bg-surface-raised px-3 py-1 text-sm text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
              >
                Search
                <kbd className="rounded border border-border px-1 py-0.5 font-mono text-xs font-medium text-content-subtle">
                  {isMac ? '⌘K' : 'Ctrl+K'}
                </kbd>
              </button>
              <NotificationBell />
              <ThemeToggle />
              <button
                type="button"
                onClick={logout}
                className="rounded-control px-2.5 py-1 text-sm font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        <main className={cx('flex-1 px-6 py-7', CONTENT_WIDTH[width])}>
          <Breadcrumbs pathname={pathname} />
          {children}
        </main>
      </div>

      <CommandPalette />
    </div>
  );
};
