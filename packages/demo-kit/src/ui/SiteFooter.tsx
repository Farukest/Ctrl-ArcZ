import { IconBook, IconExternal, IconSlides } from './icons.js';
import { useT } from '../i18n/context.js';

/**
 * The two places a visitor goes after the app itself: the documentation and the
 * deck.
 *
 * Both are outside the React app -- the docs are a separate site and the deck is a
 * PDF -- so they are plain anchors, not routes, and they open in a new tab: the app
 * holds a wallet session, and sending someone away from it to read is a good way to
 * lose their place mid-payment.
 *
 * It sits below the app shell rather than inside it so it stays put whether or not
 * a wallet is connected. Nothing here depends on session state.
 */
export function SiteFooter() {
  const t = useT();

  return (
    <footer className="sitefooter">
      <a
        className="sitefooter__card"
        href="https://docs.ctrlarcz.xyz"
        target="_blank"
        rel="noreferrer"
        data-testid="footer-docs"
      >
        <span className="sitefooter__icon" aria-hidden="true">
          <IconBook width={20} height={20} />
        </span>
        <span className="sitefooter__body">
          <span className="sitefooter__title">{t('footer.docs')}</span>
          <span className="sitefooter__sub">{t('footer.docsSub')}</span>
        </span>
        <IconExternal className="sitefooter__go" width={14} height={14} aria-hidden="true" />
      </a>

      <a
        className="sitefooter__card"
        href="/deck.pdf"
        target="_blank"
        rel="noreferrer"
        data-testid="footer-deck"
      >
        <span className="sitefooter__icon" aria-hidden="true">
          <IconSlides width={20} height={20} />
        </span>
        <span className="sitefooter__body">
          <span className="sitefooter__title">{t('footer.deck')}</span>
          <span className="sitefooter__sub">{t('footer.deckSub')}</span>
        </span>
        <IconExternal className="sitefooter__go" width={14} height={14} aria-hidden="true" />
      </a>
    </footer>
  );
}
