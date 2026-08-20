import type { ReactNode } from 'react';
import {
  IconAndroid,
  IconApple,
  IconBook,
  IconExternal,
  IconGithub,
  IconNpm,
  IconSlides,
} from './icons.js';
import { useT } from '../i18n/context.js';

/**
 * Where the project lives outside this page: the docs, the deck, the source, the
 * two apps and the SDK.
 *
 * It used to be two cards sitting directly under the last card of the screen, on
 * the same background and inside the same column, which made it read as one more
 * block of the app -- a third thing to deal with after your subscriptions rather
 * than the end of the page. Everything about it says otherwise now: its own band
 * across the full width, its own surface, and a rule above it. The app stops; this
 * is the site it is part of.
 *
 * Every destination is off this page, so they are plain anchors rather than
 * routes, and every one of them opens in a new tab. The app holds a wallet
 * session, and sending someone away from it to read the docs is a good way to lose
 * their place in the middle of a payment.
 *
 * It renders outside the app shell rather than inside it, so it stays put whether
 * or not a wallet is connected. Nothing here depends on session state.
 */

function Card({
  href,
  icon,
  title,
  sub,
  testId,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  sub: string;
  testId: string;
}) {
  return (
    <a
      className="sitefooter__card"
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
    >
      <span className="sitefooter__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sitefooter__body">
        <span className="sitefooter__title">{title}</span>
        <span className="sitefooter__sub">{sub}</span>
      </span>
      <IconExternal className="sitefooter__go" width={14} height={14} aria-hidden="true" />
    </a>
  );
}

export function SiteFooter() {
  const t = useT();

  return (
    <footer className="sitefooter" data-testid="site-footer">
      <div className="sitefooter__inner">
        <div className="sitefooter__head">
          <span className="sitefooter__wordmark">Ctrl+ArcZ</span>
          <span className="sitefooter__tagline">{t('footer.tagline')}</span>
        </div>

        <nav className="sitefooter__grid" aria-label={t('footer.nav')}>
          <Card
            href="https://docs.ctrlarcz.xyz"
            icon={<IconBook width={20} height={20} />}
            title={t('footer.docs')}
            sub={t('footer.docsSub')}
            testId="footer-docs"
          />
          <Card
            href="https://github.com/Farukest/Ctrl-ArcZ"
            icon={<IconGithub width={19} height={19} />}
            title={t('footer.github')}
            sub={t('footer.githubSub')}
            testId="footer-github"
          />
          <Card
            href="https://www.npmjs.com/package/@ctrl-arcz/sdk"
            icon={<IconNpm width={20} height={20} />}
            title={t('footer.sdk')}
            sub={t('footer.sdkSub')}
            testId="footer-sdk"
          />
          <Card
            href="https://play.google.com/store/apps/details?id=com.xyz.ctrlarcz"
            icon={<IconAndroid width={19} height={19} />}
            title={t('footer.android')}
            sub={t('footer.androidSub')}
            testId="footer-android"
          />
          {/*
            Not a link, because there is nowhere to go yet.

            Written as a card rather than left out so the row says what is coming
            without anyone having to ask, and rendered as a span rather than a
            disabled anchor: a link that goes nowhere is still offered by a screen
            reader and still takes a tab stop, which is a promise the page cannot
            keep. The chip is the whole message.
          */}
          <span className="sitefooter__card sitefooter__card--soon" data-testid="footer-ios">
            <span className="sitefooter__icon" aria-hidden="true">
              <IconApple width={19} height={19} />
            </span>
            <span className="sitefooter__body">
              <span className="sitefooter__title">{t('footer.ios')}</span>
              <span className="sitefooter__sub">{t('footer.iosSub')}</span>
            </span>
            <span className="sitefooter__soon">{t('footer.soon')}</span>
          </span>
          <Card
            href="/deck.pdf"
            icon={<IconSlides width={20} height={20} />}
            title={t('footer.deck')}
            sub={t('footer.deckSub')}
            testId="footer-deck"
          />
        </nav>

        {/* The one sentence someone should not have to look for. */}
        <p className="sitefooter__note">{t('footer.note')}</p>
      </div>
    </footer>
  );
}
