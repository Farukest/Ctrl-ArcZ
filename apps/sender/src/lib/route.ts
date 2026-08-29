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

/**
 * Every tab the address can hold, by the parameter that carries it.
 *
 * One shape rather than a function per control: a tab is a named choice, and the
 * only thing that differs between them is which word in the URL holds it.
 */
export interface Route {
  tab?: Tab;
  view?: ActivityView;
  /** Send or Receive. */
  mode?: string;
  /** The bridge's route: cctp or gateway. */
  engine?: string;
  /** Pay's kind: protected or private. */
  pay?: string;
}

const TABS: readonly Tab[] = ['pay', 'bridge', 'subscriptions', 'activity'];
const VIEWS: readonly ActivityView[] = ['sent', 'history', 'bridge', 'subs'];

/**
 * The current address with these choices changed and everything else kept.
 *
 * Merging rather than rebuilding is what makes it usable from anywhere: switching
 * the bridge's route must not drop the fact that you are on the bridge, and `?tid=`
 * points at a transfer to open and has nothing to do with any of this.
 */
export function hrefWith(patch: Route): string {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const q = params.toString();
  return q ? `?${q}` : window.location.pathname;
}

/** Record the move. Same merge, written to the browser's history. */
export function pushWith(patch: Route): void {
  const next = `${window.location.pathname}${hrefWith(patch)}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.pushState(null, '', next);
  }
}

/** The address of a tab, with the Activity screen's row set when it has one. */
export function hrefFor(tab: Tab, view?: ActivityView): string {
  return hrefWith({ tab, ...(view ? { view } : {}) });
}

/** What the current address says, ignoring anything it does not recognise. */
export function readRoute(search: string): Route {
  const p = new URLSearchParams(search);
  const tab = p.get('tab');
  const view = p.get('view');
  const pick = (key: string, allowed: readonly string[]) => {
    const v = p.get(key);
    return v && allowed.includes(v) ? { [key]: v } : {};
  };
  return {
    ...(TABS.includes(tab as Tab) ? { tab: tab as Tab } : {}),
    ...(VIEWS.includes(view as ActivityView) ? { view: view as ActivityView } : {}),
    ...pick('mode', ['send', 'receive']),
    ...pick('engine', ['cctp', 'gateway']),
    ...pick('pay', ['protected', 'private']),
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
