// Motion (design §6): the token slide, the lane slide, and the highlights. All of it is off under
// `prefers-reduced-motion`. CSS animations are switched off by app.css's media query; the
// JS-driven ones (the crossfade between cells, the lane flip) take their duration from here.

import { isRecord } from './job';

/** Whether the user asked for reduced motion; false where there is no `matchMedia` (tests). */
export function reducedMotion(): boolean {
  const match: unknown = Reflect.get(globalThis, 'matchMedia');
  if (typeof match !== 'function') return false;
  const query: unknown = match.call(globalThis, '(prefers-reduced-motion: reduce)');
  return isRecord(query) && query.matches === true;
}

/** A transition's duration: `ms`, or 0 under reduced motion. */
export const motionMs = (ms: number, reduced: boolean = reducedMotion()): number => (reduced ? 0 : ms);
