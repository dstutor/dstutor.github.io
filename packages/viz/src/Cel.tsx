import { forwardRef } from 'react';
import { CEL_SVG, type CelState } from '@dstutor/brand';
import '@dstutor/brand/cel.css';

const [, CEL_INNER] = CEL_SVG.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/) ?? ['', ''];

/** Cel, the bracket mascot, in one of its states (styles in @dstutor/brand/cel.css) */
const Cel = forwardRef<SVGSVGElement, { state: CelState; className?: string }>(function Cel({ state, className }, ref) {
  return (
    <svg
      ref={ref}
      className={className ? `cel ${className}` : 'cel'}
      data-state={state}
      viewBox="0 0 120 100"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: CEL_INNER }}
    />
  );
});

export default Cel;
