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
/**
 * Nav icons. Deliberately hairline geometric strokes on a 24px grid, not filled/rounded glyphs:
 * the whole design register here is "ruled and printed", and a set of soft filled icons is exactly
 * the generic-SaaS tell the 3px radius was chosen to avoid. Every path uses `currentColor` and
 * inherits stroke width, so an icon picks up the active/muted/hover colour of its own link with no
 * per-state variants and no theme-specific asset.
 *
 * These earn their place twice: they give the expanded rail a scannable left edge (previously a
 * flat wall of same-size text), and they replace the two-letter abbreviation the COLLAPSED rail
 * used to fall back to, which was genuinely hard to read ("Su" for both Suppliers and Supplier
 * scorecard, "Re" for Recipes and Reorder suggestions).
 */
const ICONS: Record<string, string> = {
  overview: 'M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z',
  finding: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  manager: 'M3 20h18M6 20V10M12 20V4M18 20v7',
  variance: 'M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5',
  assistant: 'M4 5h16v11H9l-5 4V5z',
  financeController: 'M12 2v20M8 6h5.5a2.5 2.5 0 0 1 0 5H9a2.5 2.5 0 0 0 0 5h6.5',
  notifications: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 21h4',
  products: 'M3 8l9-5 9 5-9 5-9-5zM3 8v8l9 5 9-5V8',
  categories: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z',
  recipes: 'M6 3v18M6 3a3 3 0 0 1 0 6M14 3c-2 0-3 3-3 6s1 3 3 3 3 0 3-3-1-6-3-6zM14 12v9',
  suppliers: 'M3 16V8h11v8M14 11h4l3 3v2h-7M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  import: 'M12 3v12M8 11l4 4 4-4M4 19h16',
  inventory: 'M4 7h16v13H4zM4 7l2-4h12l2 4M10 12h4',
  documents: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6',
  purchaseOrders: 'M7 4h10l2 4v13H5V8zM5 8h14M9 12h6M9 16h4',
  reorder: 'M4 12a8 8 0 0 1 13.7-5.7M20 12a8 8 0 0 1-13.7 5.7M17 3v4h-4M7 21v-4h4',
  scorecard: 'M4 4h16v16H4zM8 15v-4M12 15V8M16 15v-6',
  integrations: 'M9 3v6M15 3v6M6 9h12v4a6 6 0 0 1-12 0zM12 19v2',
  posMapping: 'M4 6h6v6H4zM14 12h6v6h-6zM10 9h4M12 9v6',
  salesImport: 'M12 21V9M8 13l4-4 4 4M4 5h16',
  setup: 'M12 3l2.1 4.4 4.9.6-3.6 3.4.9 4.8L12 14l-4.3 2.2.9-4.8L5 8l4.9-.6z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
};

const NavIcon = ({ name }: { name: string }) => {
  const path = ICONS[name];
  if (!path) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4.5 shrink-0"
    >
      <path d={path} />
    </svg>
  );
};

const NAV_GROUPS: { label: string; items: { href: string; label: string; icon: string }[] }[] = [
  {
    label: 'Watch',
    items: [
      { href: '/dashboard', label: 'Overview', icon: 'overview' },
      { href: '/first-finding-report', label: 'First finding', icon: 'finding' },
      { href: '/dashboard/manager', label: 'Manager view', icon: 'manager' },
      { href: '/purchase-orders/variance-queue', label: 'Variance queue', icon: 'variance' },
      { href: '/assistant', label: 'Assistant', icon: 'assistant' },
      { href: '/finance-controller', label: 'Finance Controller', icon: 'financeController' },
      { href: '/notifications', label: 'Notifications', icon: 'notifications' },
    ],
  },
  {
    label: 'Catalogue',
    items: [
      { href: '/products', label: 'Products', icon: 'products' },
      { href: '/categories', label: 'Categories', icon: 'categories' },
      { href: '/recipes', label: 'Recipes', icon: 'recipes' },
      { href: '/suppliers', label: 'Suppliers', icon: 'suppliers' },
      { href: '/import-templates', label: 'Import templates', icon: 'import' },
    ],
  },
  {
    label: 'Movement',
    items: [
      { href: '/inventory', label: 'Inventory', icon: 'inventory' },
      { href: '/documents', label: 'Documents', icon: 'documents' },
      { href: '/purchase-orders', label: 'Purchase orders', icon: 'purchaseOrders' },
      { href: '/purchase-orders/suggestions', label: 'Reorder suggestions', icon: 'reorder' },
      { href: '/purchase-orders/supplier-scorecard', label: 'Supplier scorecard', icon: 'scorecard' },
    ],
  },
  {
    label: 'Connections',
    items: [
      { href: '/integrations', label: 'Integrations', icon: 'integrations' },
      { href: '/pos-items', label: 'POS mapping', icon: 'posMapping' },
      { href: '/sales-import', label: 'Sales import', icon: 'salesImport' },
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
  metric: 'Figure',
  net_revenue: 'Net revenue',
  contribution_margin: 'Contribution margin',
  food_cost_percentage: 'Food cost %',
  stock_value: 'Stock value',
  assistant: 'Assistant',
  'finance-controller': 'Finance Controller',
  reconciliation: 'Batch reconciliation',
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
  'import-templates': 'Import templates',
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
/** A uuid (v4/v7) or any other long hex/digit run — the shape of a real entity id in a route. */
const ID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A segment with no entry in `SEGMENT_LABELS` is one of two genuinely different things, and
 * collapsing both to "Detail" is what produced the "Overview / Detail / Detail" breadcrumbs seen
 * live on several routes:
 *
 * - an ENTITY ID (`/purchase-orders/01a0562d-…`) — "Detail" is the right word; the entity's real
 *   name is in the PageHeader directly below, so repeating it here would be noise.
 * - an unmapped WORD segment (`/dashboard/metric/net_revenue`) — "Detail" is simply a missing
 *   label. Humanising the slug is always better than discarding it, and it degrades gracefully as
 *   new routes are added without anyone having to remember to update the map.
 */
const labelForUnmappedSegment = (segment: string): string => {
  if (ID_SHAPED.test(segment)) return 'Detail';
  const humanised = segment.replace(/[-_]+/g, ' ').trim();
  if (humanised === '') return 'Detail';
  return humanised.charAt(0).toUpperCase() + humanised.slice(1);
};

const Breadcrumbs = ({ pathname }: { pathname: string }) => {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || NO_BREADCRUMBS.has(pathname)) return null;
  const crumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    return {
      href,
      label: SEGMENT_LABELS[segment] ?? labelForUnmappedSegment(segment),
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
                  <NavIcon name={item.icon} />
                  {!collapsed && item.label}
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
  // `/confirm-detected` is a real step OF the setup flow (the wizard links straight to it), so it
  // keeps the "Get set up" entry highlighted rather than leaving the user with no active nav item.
  const onboardingActive = isActive('/onboarding', pathname) || isActive('/confirm-detected', pathname);

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
          'flex flex-col border-r border-border bg-surface-raised transition-[width] duration-150 ease-out',
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
          {/* Deliberately in the footer utility strip, not in one of the four operational groups
              above: "Get set up" is a first-run task, not something an operator does every shift,
              so it doesn't sit as a peer of "Overview" or "Inventory". Before this existed, both
              /onboarding and /confirm-detected were genuinely UNREACHABLE — they linked only to
              each other, so a user who finished signup could never find the guided setup wizard at
              all. Breadcrumb labels for both already existed, which is what made the gap invisible. */}
          <Link
            href="/onboarding"
            title={collapsed ? 'Get set up' : undefined}
            aria-current={onboardingActive ? 'page' : undefined}
            className={cx(
              'flex items-center gap-2.5 rounded-control border-l-2 py-1.5 text-sm transition-colors',
              collapsed ? 'justify-center px-2' : 'px-2.5',
              onboardingActive
                ? 'border-l-accent bg-accent-soft font-semibold text-content'
                : 'border-l-transparent text-content-muted hover:bg-surface-sunken hover:text-content'
            )}
          >
            <NavIcon name="setup" />
            {!collapsed && 'Get set up'}
            {collapsed && <span className="sr-only">Get set up</span>}
          </Link>
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
            <NavIcon name="settings" />
            {!collapsed && 'Settings'}
            {collapsed && <span className="sr-only">Settings</span>}
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
