/**
 * Whether this click is ours to handle rather than the browser's.
 *
 * A plain left click on a link means "go there", and an app that routes in the
 * page can do that without a reload. Anything with a modifier, or any other
 * button, means the reader has asked for something an onClick must not take away:
 * a new tab, a new window, a download.
 *
 * Lives in the kit because every in-page link needs the same answer, and getting
 * it wrong is invisible until somebody middle-clicks and nothing happens.
 */
export function isPlainClick(e: {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}): boolean {
  return (
    !e.defaultPrevented &&
    (e.button ?? 0) === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey
  );
}
