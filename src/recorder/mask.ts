/** Record the shape of typed text, not the value: digit -> 9, letter -> a, others kept. */
export function shapeMask(text: string): string {
  return text.replace(/[0-9]/g, '9').replace(/\p{L}/gu, 'a');
}

type InputLike = { type?: string; autocomplete?: string } | null | undefined;

/** Default maskInputFn: passwords and card fields fully masked, everything else by shape. */
export function defaultMaskInput(text: string, el?: InputLike): string {
  const type = (el?.type ?? '').toLowerCase();
  const ac = (el?.autocomplete ?? '').toLowerCase();
  if (type === 'password' || ac.includes('password') || ac.startsWith('cc-')) return '*'.repeat(text.length);
  return shapeMask(text);
}
