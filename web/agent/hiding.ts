// Whether a page hides text from the people who look at it, as opposed to merely having parts that are not on screen
// (menus, dialogs and tabs are `display: none` on nearly every page). The collector names the reasons it found; only
// the ones that exist to deceive count here: a size of zero, full transparency, and the colour of the background.
// `clipped` and `offscreen` are left out on purpose: the standard way to write text for screen readers looks like both.
// The hooks (009) still read every piece of hidden text, whatever the reason; this only decides what the report says.

const DECEPTIVE = new Set(['zero_size', 'transparent', 'low_contrast']);

export function hidesText(hidden: unknown): boolean {
  if (typeof hidden !== 'object' || hidden === null) return false;
  const h = hidden as Record<string, unknown>;
  return h.present === true && Array.isArray(h.reasons) && h.reasons.some((r) => typeof r === 'string' && DECEPTIVE.has(r));
}
