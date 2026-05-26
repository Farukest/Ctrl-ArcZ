import type { SessionState } from '../useSession.js';
import { useT } from '../i18n/context.js';
import { AddressChip, Button, Skeleton } from './components.js';
import { IconWallet, IconAlert } from './icons.js';

/** Wallet connection bar + chain guard. Presentational: driven by useSession(). */
export function ConnectBar({ state }: { state: SessionState }) {
  const t = useT();
  const { session, balance, connecting, reconnecting, error, walletDetected } = state;

  return (
    <>
      <div className="card connectbar">
        {reconnecting && !session ? (
          <div className="connectbar__row" aria-busy data-testid="reconnecting">
            <div className="connectbar__id">
              <Skeleton width={132} height={28} />
              <Skeleton width={72} height={16} />
            </div>
            <Skeleton width={88} height={34} />
          </div>
        ) : session ? (
          <div className="connectbar__row">
            <div className="connectbar__id">
              <AddressChip address={session.address} />
              <div className="connectbar__balance">
                <span className="connectbar__amount">
                  {Number(balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </span>
                <span className="connectbar__unit">USDC</span>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={state.disconnect} data-testid="disconnect">
              {t('common.disconnect')}
            </Button>
          </div>
        ) : (
          <div className="row-between wrap">
            <span className="muted">
              {walletDetected ? t('common.connectPrompt') : t('common.noWallet')}
            </span>
            {walletDetected ? (
              <Button
                onClick={() => void state.connect()}
                loading={connecting}
                data-testid="connect"
              >
                <IconWallet width={18} height={18} />
                {connecting ? t('common.connecting') : t('common.connect')}
              </Button>
            ) : (
              <a
                className="btn btn--ghost"
                href="https://metamask.io/download/"
                target="_blank"
                rel="noreferrer"
              >
                {t('common.installWallet')}
              </a>
            )}
          </div>
        )}
        {error && (
          <div className="err-text" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      {session && !session.onArc && (
        <div className="banner banner--warn" data-testid="wrong-chain">
          <IconAlert width={18} height={18} />
          <span className="grow">{t('common.wrongChain', { chainId: session.chainId })}</span>
          <Button size="sm" onClick={() => void state.switchChain()} data-testid="switch-chain">
            {t('common.switchToArc')}
          </Button>
        </div>
      )}
    </>
  );
}
