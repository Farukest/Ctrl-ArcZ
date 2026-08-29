import { isPlainClick } from '@ctrl-arcz/demo-kit';

export { isPlainClick };

/**
 * Where you are, as an address rather than as component state.
 *
 * The tabs were state and nothing else, which is fine until something wants to
 * link to one. A button with an onClick cannot be middle-clicked into a new tab,
 * cannot be copied as a link, and cannot be returned to with the back arrow,
 * because as far as the browser is concerned nothing ever happened. Those are not
 * features to add one at a time; they are what a real `href` gives for free.
 *
 * So a tab has a URL. Left-clicking one still moves inside the page, with no
 * reload and no flash: the handler takes the plain click and pushes the address.
 * Every other kind of click is handed straight to the browser, which already knows
 * what a middle click means.
 */

export type Tab = 'pay' | 'bridge' | 'subscriptions' | 'activity';

/** The row sets inside the Activity screen. */
export type ActivityView = 'sent' | 'history' | 'bridge' | 'subs';

const TABS: readonly Tab[] = ['pay', 'bridge', 'subscriptions', 'activity'];
const VIEWS: readonly ActivityView[] = ['sent', 'history', 'bridge', 'subs'];

/** The address of a tab, with the Activity screen's row set when it has one. */
export function hrefFor(tab: Tab, view?: ActivityView): string {
  const params = new URLSearchParams();
  params.set('tab', tab);
  if (view) params.set('view', view);
  return `?${params.toString()}`;
}

/** What the current address says, ignoring anything it does not recognise. */
export function readRoute(search: string): { tab?: Tab; view?: ActivityView } {
  const p = new URLSearchParams(search);
  const tab = p.get('tab');
  const view = p.get('view');
  return {
    ...(TABS.includes(tab as Tab) ? { tab: tab as Tab } : {}),
    ...(VIEWS.includes(view as ActivityView) ? { view: view as ActivityView } : {}),
  };
}

/**
 * Record the move, keeping every other parameter.
 *
 * `?tid=` points at a transfer to open and has nothing to do with which tab is
 * showing; dropping it here would close a link somebody followed.
 */
export function pushRoute(tab: Tab, view?: ActivityView): void {
  const params = new URLSearchParams(window.location.search);
  params.set('tab', tab);
  if (view) params.set('view', view);
  else params.delete('view');
  const next = `${window.location.pathname}?${params.toString()}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.pushState(null, '', next);
  }
}
