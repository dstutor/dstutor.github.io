import { CEL_SVG, type CelState } from '@dstutor/brand';

const [, CEL_INNER] = CEL_SVG.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/) ?? ['', ''];

/** Cel, the bracket mascot, in one of its states (styles in @dstutor/brand/cel.css) */
export default function Cel({ state, className }: { state: CelState; className?: string }) {
  return (
    <svg
      className={className ? `cel ${className}` : 'cel'}
      data-state={state}
      viewBox="0 0 120 100"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: CEL_INNER }}
    />
  );
}
