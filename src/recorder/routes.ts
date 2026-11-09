export type AddCustomEvent = (tag: string, payload: unknown) => void;

/** Emit an `nr:route` custom event on pushState, replaceState, popstate and hashchange. Returns a restore function. */
export function trackRoutes(add: AddCustomEvent): () => void {
  const emit = () => add('nr:route', { href: location.href });
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
    const r = origPush.apply(this, args);
    emit();
    return r;
  };
  history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
    const r = origReplace.apply(this, args);
    emit();
    return r;
  };
  addEventListener('popstate', emit);
  addEventListener('hashchange', emit);
  emit();
  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    removeEventListener('popstate', emit);
    removeEventListener('hashchange', emit);
  };
}
