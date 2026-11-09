/** Record the shape of typed text, not the value: digit -> 9, letter -> a, others kept. */
export function shapeMask(text: string): string {
  return text.replace(/[0-9]/g, '9').replace(/\p{L}/gu, 'a');
}

type InputLike = { type?: string; autocomplete?: string } | null | undefined;

/**
 * Every input type rrweb should route through maskInputFn. rrweb's own `maskAllInputs: true`
 * leaves `hidden` out, so CSRF tokens and private ids would be recorded unchanged.
 */
export const MASK_ALL_INPUT_TYPES = {
  color: true, date: true, 'datetime-local': true, email: true, month: true, number: true, range: true,
  search: true, tel: true, text: true, time: true, url: true, week: true, textarea: true, select: true,
  password: true, hidden: true,
} as const;

/** Default maskInputFn: hidden inputs, passwords and card fields fully masked, everything else by shape. */
export function defaultMaskInput(text: string, el?: InputLike): string {
  const type = (el?.type ?? '').toLowerCase();
  const ac = (el?.autocomplete ?? '').toLowerCase();
  if (type === 'hidden' || type === 'password' || ac.includes('password') || ac.startsWith('cc-')) return '*'.repeat(text.length);
  return shapeMask(text);
}
