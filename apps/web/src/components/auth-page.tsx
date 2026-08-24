import type { ReactNode } from 'react';
import { AuthIntro } from './auth-intro';
import { ThemeToggle } from './theme-toggle';

/**
 * The shared shell for every signed-out screen: sign-in, sign-up, email verification, password
 * reset and invitation acceptance.
 *
 * All six pages had independently repeated the same `<main className="grid min-h-screen
 * place-items-center px-6 py-12">` wrapper plus an absolutely-positioned `ThemeToggle`, so the
 * ledger ground would otherwise have had to be pasted into six files and kept in sync by hand.
 * Centralising it also means the next auth screen gets the treatment by construction rather than by
 * somebody remembering.
 *
 * The ground stays the plain surface colour, deliberately. Two patterned treatments were built and
 * both were rejected on screen: a viewport-wide ruled grid read as a rendering artifact (a lone
 * margin rule with nothing beside it, and a visible blank ellipse where the pattern was masked away
 * for the card), and a literal bordered "sheet of ledger paper" read as a spreadsheet — two dense
 * rectangles competing, with an empty left column. The lesson was that this screen's problem was
 * never the background: it was that the page said nothing, which `LogoLockup` now fixes. A quiet
 * ground behind a considered lockup beats a decorated one.
 */
export const AuthPage = ({
  children,
  intro = false,
}: {
  children: ReactNode;
  /**
   * Adds the brand pane, for the two screens a stranger can arrive at cold: sign-in and sign-up.
   * The other four are reached from a link in an email — those people know what this is and are
   * mid-task, so a brand pane beside "set a new password" would be noise.
   */
  intro?: boolean;
}) => {
  if (!intro) {
    return (
      <main className="grid min-h-screen place-items-center px-6 py-12">
        <div className="absolute right-6 top-6">
          <ThemeToggle />
        </div>
        {children}
      </main>
    );
  }

  /*
   * A 40/60 split, with the brand half INVERTED against the form half.
   *
   * In the light theme the brand side is a deep warm brown-black and the form side is paper; in the
   * dark theme they swap, so the brand side is always the darker-or-lighter counterpart of the form
   * rather than a slightly different shade of it. A tonal step of one or two percent (the earlier
   * `surface-sunken` version) is invisible at a glance and reads as a rendering seam; a real
   * inversion reads as a deliberate composition, and gives the wordmark a ground it stands out on.
   *
   * The inverted panel defines its OWN foreground tokens rather than relying on the theme's, which
   * is what lets `AuthIntro` stay theme-agnostic — it styles with `text-content` and friends, and
   * those resolve correctly inside the panel because the panel redefines them.
   *
   * Both halves centre their content, and the padding is generous and symmetric so neither side
   * hugs the divider.
   */
  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[40fr_60fr]">
      <div className="absolute right-6 top-6 z-10">
        <ThemeToggle />
      </div>

      <div className="auth-brand-panel hidden px-12 py-16 lg:flex lg:items-center lg:justify-center xl:px-14">
        <AuthIntro />
      </div>

      <div className="flex min-h-screen items-center justify-center px-6 py-16 lg:min-h-0 lg:px-14 xl:px-20">
        {children}
      </div>
    </main>
  );
};
