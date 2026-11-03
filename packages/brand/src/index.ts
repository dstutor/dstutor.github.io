// Cel, the dstutor bracket mascot: CEL_SVG carries the parts for every state and cel.css picks
// which show. Used by the tutors; the hub inlines its own copy of the logo.

export type CelState = 'brand' | 'idle' | 'running' | 'done' | 'error' | 'removed' | 'grouped';

/**
 * Cel's markup, with the parts for every state; set data-state on the <svg> to pick one.
 */
export const CEL_SVG = `<svg class="cel" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
<path class="cel-bracket" d="M40 12 H22 V88 H40"/><path class="cel-bracket" d="M80 12 H98 V88 H80"/>
<g class="cel-eyes"><circle cx="48" cy="52" r="7.5"/><circle cx="72" cy="52" r="7.5"/></g>
<g class="cel-glints"><circle cx="50.5" cy="49.5" r="2"/><circle cx="74.5" cy="49.5" r="2"/></g>
<path class="cel-face cel-dashes" d="M42 52 H54 M66 52 H78"/>
<path class="cel-face cel-crosses" d="M42 44 L54 60 M54 44 L42 60 M66 44 L78 60 M78 44 L66 60"/>
<path class="cel-face cel-smile" d="M50 68 Q60 76 70 68"/>
<path class="cel-face cel-frown" d="M50 72 Q60 64 70 72"/>
<path class="cel-spark" d="M60 20 V30 M51 25 H69 M53.5 19 L66.5 31 M66.5 19 L53.5 31"/>
<g class="cel-stack"><rect x="78" y="66" width="20" height="18" rx="5"/><rect x="83" y="71" width="20" height="18" rx="5"/></g>
</svg>`;
