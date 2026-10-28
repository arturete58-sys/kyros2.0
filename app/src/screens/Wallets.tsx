/**
 * The business's wallets: the one that signs the vault, and any others the
 * business gets paid in. What the others receive counts as the business's
 * income (prepayments, deductions, the assistant), and the screen says how
 * much of it Kyros would have set aside.
 */
import { useState } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { addWallet, money, outsideOf, ownAddresses, refreshOutside, removeWallet, setAsideOutside, setIncome } from '../kyros';
import { fmtDate, t } from '../i18n';
import { Button, Tabs, Top, useApp } from '../ui';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Wallets() {
  const { vault, snap, chain, wallet, go, setVault, run, refresh } = useApp();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [, setTick] = useState(0);
  if (!vault) return null;
  const view = outsideOf(vault, snap?.pack ?? null);
  const add = () => {
    const a = address.trim().toUpperCase();
    if (!StrKey.isValidEd25519PublicKey(a) && !StrKey.isValidContract(a)) return setError(t('walletsBad'));
    if (ownAddresses(vault).includes(a) && !(vault.wallets ?? []).some((w) => w.address === a)) return setError(t('walletsOwn'));
    setError('');
    const next = addWallet(vault, a, label.trim() || undefined);
    setAddress('');
    setLabel('');
    void run(t('walletsAdd'), async () => {
      await refreshOutside(chain, next, snap?.pack ?? null, true);
      setVault(next);
      go('wallets');
      await refresh();
    });
  };
  const cur = (code: string) => (code.toUpperCase().includes('EUR') ? 'EURC' : 'USDC');
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('settings')} />
        <h1>{t('walletsTitle')}</h1>
        <p className="muted">{t('walletsSub')}</p>
        <section className="card" data-testid="wallets">
          <div className="row spread small">
            <span className="mono" title={vault.owner}>
              {short(vault.owner)}
            </span>
            <span className="badge ok">{t('walletsMain')}</span>
          </div>
          {(vault.wallets ?? []).map((w) => (
            <div className="row spread small" key={w.address}>
              <span>
                {w.label ? `${w.label} · ` : ''}
                <span className="mono" title={w.address}>
                  {short(w.address)}
                </span>
              </span>
              <button
                className="link small"
                onClick={() => {
                  setVault(removeWallet(vault, w.address));
                  go('wallets');
                }}
              >
                {t('walletsRemove')}
              </button>
            </div>
          ))}
          <div className="field">
            <label htmlFor="wallet-address">{t('walletsAddress')}</label>
            <input id="wallet-address" data-testid="wallet-address" className="input mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="G…" />
          </div>
          <div className="field">
            <label htmlFor="wallet-label">{t('walletsLabel')}</label>
            <input id="wallet-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {error && (
            <p className="small" role="alert">
              {error}
            </p>
          )}
          <Button small testid="wallet-add" disabled={!address.trim()} onClick={add}>
            {t('walletsAdd')}
          </Button>
        </section>
        {(vault.wallets ?? []).length > 0 && (
          <section className="card" data-testid="wallet-payments">
            <p style={{ fontWeight: 600 }}>{t('walletsPayments')}</p>
            {view.all.length === 0 && <p className="small muted">{t('walletsNone')}</p>}
            {view.all.map((p) => (
              <label key={p.id} className="row small" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={p.income}
                  aria-label={t('walletsIsIncome')}
                  onChange={(e) => {
                    setIncome(vault, p.id, e.target.checked);
                    setTick((x) => x + 1);
                  }}
                />
                <span className="grow">
                  <b className="num">
                    {money(p.amount)} {cur(p.code)}
                  </b>{' '}
                  <span className="muted">
                    {t('walletsFrom', { from: short(p.from) })} · {fmtDate(new Date(p.at))}
                  </span>
                  {p.setAside && <span className="badge ok"> {t('walletsSetAsideDone')}</span>}
                  <br />
                  <span className="tiny muted">{t('walletsIsIncome')}</span>
                </span>
              </label>
            ))}
            {view.total > 0n && (
              <>
                <div className="stats">
                  <div>
                    <span className="tiny muted">{t('walletsTotal')}</span>
                    <b className="num" data-testid="wallets-total">
                      {money(view.total)}
                    </b>
                  </div>
                  <div>
                    <span className="tiny muted">{t('walletsPending')}</span>
                    <b className="num">{money(view.pending.total)}</b>
                  </div>
                </div>
                {view.pending.total > 0n && (
                  <>
                    <p className="small">{t('walletsPendingBody', { total: money(view.pending.total), vat: money(view.pending.vat), reserve: money(view.pending.reserve) })}</p>
                    {wallet && snap && !vault.archivedOf && (
                      <>
                        <Button
                          small
                          testid="wallets-set-aside"
                          onClick={() =>
                            run(t('walletsSetAside', { amount: money(view.pending.total) }), async (step) => {
                              await setAsideOutside(chain, wallet, vault, snap, step);
                              setTick((x) => x + 1);
                              await refresh();
                            })
                          }
                        >
                          {t('walletsSetAside', { amount: money(view.pending.total) })}
                        </Button>
                        <p className="tiny muted">{t('walletsSetAsideBody')}</p>
                      </>
                    )}
                  </>
                )}
                <p className="tiny muted">{t('walletsCounted')}</p>
              </>
            )}
            {(vault.wallets ?? []).some((w) => w.address.startsWith('C')) && <p className="tiny muted">{t('walletsRecent')}</p>}
          </section>
        )}
      </div>
      <Tabs current="settings" />
    </>
  );
}

/** Home: income in the other wallets that Kyros did not set aside. */
export function WalletsCard() {
  const { vault, snap, go } = useApp();
  if (!vault || vault.archivedOf || !(vault.wallets ?? []).length) return null;
  const view = outsideOf(vault, snap?.pack ?? null);
  if (view.total === 0n) return null;
  return (
    <button className="card link-card" data-testid="wallets-card" onClick={() => go('wallets')}>
      <div className="row spread">
        <b>{t('walletsTitle')}</b>
        <span aria-hidden>›</span>
      </div>
      <span className="small muted">{t('walletsHome', { total: money(view.total), pending: money(view.pending.total) })}</span>
    </button>
  );
}
