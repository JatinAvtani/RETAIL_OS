'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { Input } from './ui';

/**
 * A password field with a show/hide control.
 *
 * The button is a real `<button type="button">`, not an icon with a click handler: inside a `<form>`
 * an unspecified type defaults to `submit`, so revealing the password would submit the form. It also
 * carries `aria-pressed` rather than swapping only the icon, so the state is announced rather than
 * conveyed by shape alone — and `tabIndex={-1}` keeps it out of the tab order between the password
 * field and the submit button, where a keyboard user expects to go straight to signing in. It stays
 * reachable by pointer and by screen-reader navigation.
 *
 * Padding on the input is widened rather than the button overlaid on top of text: at a long password
 * the characters would otherwise run underneath the icon.
 */
export const PasswordInput = ({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) => {
  const [visible, setVisible] = useState(false);

  return (
    <span className="relative block">
      <Input {...props} type={visible ? 'text' : 'password'} className={`pr-10 ${className ?? ''}`} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((current) => !current)}
        aria-pressed={visible}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-control text-content-subtle transition-colors hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {visible ? (
          // Eye, struck through — "currently visible, click to hide".
          <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 10s2.5-4.5 7-4.5S17 10 17 10s-2.5 4.5-7 4.5S3 10 3 10Z" />
            <circle cx="10" cy="10" r="1.9" />
            <path d="m4 16 12-12" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 10s2.5-4.5 7-4.5S17 10 17 10s-2.5 4.5-7 4.5S3 10 3 10Z" />
            <circle cx="10" cy="10" r="1.9" />
          </svg>
        )}
      </button>
    </span>
  );
};
