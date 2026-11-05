// The library chip in the header, as a menu of every tutor: switch from polars to pandas without
// going back to the home page. Each tutor keeps its own notebook (TutorConfig.notebookStorageKey),
// so switching loses nothing.
import { useEffect, useRef, useState } from 'react';

export interface TutorLink {
  id: string;
  name: string;
  href: string;
  about: string;
}

/** Every tutor on the site, in the order the home page lists them */
export const TUTORS: TutorLink[] = [
  { id: 'datascience', name: 'datascience', href: '/datascience/', about: "UC Berkeley's library for intro data science" },
  { id: 'pandas', name: 'pandas', href: '/pandas/', about: 'DataFrames' },
  { id: 'polars', name: 'polars', href: '/polars/', about: 'DataFrames and lazy queries' },
  { id: 'sql', name: 'SQL', href: '/sql/', about: 'Queries on DuckDB' },
];

export default function TutorSwitcher({ library }: { library: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = library.toLowerCase();

  // Escape or a click elsewhere closes it
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div className="tutor-switcher" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="brand-code tutor-switcher-button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Switch to another tutor"
      >
        {library}
        <svg className="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="tutor-switcher-menu rise-in">
          <div className="tutor-switcher-title">Switch tutor</div>
          <ul>
            {TUTORS.map(t => (
              <li key={t.id}>
                <a href={t.href} className={t.id === current ? 'is-current' : ''} aria-current={t.id === current ? 'page' : undefined}>
                  <code className="tutor-switcher-name">{t.name}</code>
                  <span className="tutor-switcher-about">{t.about}</span>
                  {t.id === current && <span className="tutor-switcher-here">here</span>}
                </a>
              </li>
            ))}
          </ul>
          <a className="tutor-switcher-home" href="/">All tutors on the home page</a>
        </div>
      )}
    </div>
  );
}
