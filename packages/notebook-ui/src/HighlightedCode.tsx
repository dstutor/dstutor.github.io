// Code shown outside an editor ("Try this"), coloured by Monaco's own tokenizer so it matches the
// notebook's cells exactly. Plain text until Monaco has loaded, or if it cannot.
import { useEffect, useState } from 'react';
import { ensureMonaco } from './editorAvailability';
import type { CellLanguage } from './NotebookCells';

export default function HighlightedCode({ code, language }: { code: string; language: CellLanguage }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ensureMonaco()
      .then(ok => (ok ? import('./monacoSetup') : null))
      .then(setup => setup?.monaco.editor.colorize(code, language, { tabSize: 4 }))
      .then(colored => {
        if (alive && colored) setHtml(colored);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, language]);
  // Monaco escapes the code it colours, so its HTML is safe to insert
  return html === null
    ? <pre className="highlighted-code">{code}</pre>
    : <pre className="highlighted-code monaco-colorized" dangerouslySetInnerHTML={{ __html: html }} />;
}
