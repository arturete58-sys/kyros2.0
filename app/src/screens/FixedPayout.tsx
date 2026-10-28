/**
 * Two vault settings that change where money goes, both with notice:
 * - a fixed amount per month (the self-employed fee) set aside from the first
 *   payments of each period, before the net amount reaches the wallet;
 * - the payout address: where the net amount and whatever the vault returns
 *   go, if not the wallet that signs.
 */
import { useMemo, useState } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { fixedFeeSuggestion, monthsIn, type PeriodKind } from 'kyros-sdk';
import { cancelPending, money, perUnit, proposeFixedFee, proposePayout, rememberMine, units } from '../kyros';
import { fmtDateTime, fmtNumber, t, type Key } from '../i18n';
import { Button, pct, Tabs, Top, TxLink, useApp } from '../ui';
import { noticeWords } from './Move';

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const at = (secs: bigint) => fmtDateTime(new Date(Number(secs) * 1000));

/** "month", "quarter"... for the vault's period. */
export function periodWord(k: PeriodKind | null): string {
  const id = k?.kind === 'Month' || k?.kind === 'Quarter' || k?.kind === 'Year' ? k.kind : 'Other';
  return t(`periodWord_${id}` as Key);
}

export function FixedFee() {
  const { vault, snap, chain, wallet, run, go, refresh } = useApp();
  const pack = snap?.pack ?? null;
  const kind = snap?.periodKind ?? null;
  // The fee is set aside in the token in the tax's currency when the vault takes it, else in dollars.
  const eur = chain.cfg.tokens.eur.contract;
  const token = pack?.currency === 'EUR' || !chain.dollarTokens.length ? eur : chain.dollarTokens[0];
  const code = token === eur ? 'EURC' : 'USDC';
  const sameCurrency = !!pack && perUnit(chain, token, pack.currency)?.preferred === true;
  const suggestion = useMemo(() => {
    if (!vault || !pack || pack.id !== vault.answers.packId) return undefined;
    try {
      return fixedFeeSuggestion(pack, vault.presetId, snap?.rule ?? vault.rule, { revenue: vault.answers.revenue, activity: vault.answers.activity, region: vault.answers.region });
    } catch {
      return undefined;
    }
  }, [vault, pack, snap]);
  const current = (snap?.fixed ?? []).find((f) => f.bucket === 'social');
  const [monthly, setMonthly] = useState(() => (current && kind ? String(units(current.amount) / monthsIn(kind)) : suggestion && sameCurrency ? String(suggestion.monthly) : ''));
  const [hash, setHash] = useState<string | null>(null);
  if (!vault || !wallet || !snap) return null;
  const value = Number(monthly.replace(',', '.')) || 0;
  const word = periodWord(kind);
  const perPeriod = kind ? value * monthsIn(kind) : value;
  const filled = current ? (snap.fixedFilled[current.token]?.social ?? 0n) : 0n;
  const pending = snap.pendingFixed;
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('settings')} />
        <h1>{t('fixedTitle')}</h1>
        <p className="muted">{t('fixedSub', { period: word })}</p>
        {current && (
          <section className="card ok" data-testid="fixed-current">
            <p className="small" style={{ fontWeight: 600 }}>
              {t('fixedNow', { amount: money(current.amount, current.token === eur ? 'EURC' : 'USDC'), period: word })}
            </p>
            <p className="small muted">{t('fixedFilled', { filled: money(filled), amount: money(current.amount), period: word })}</p>
          </section>
        )}
        {pending && (
          <section className="card info" data-testid="fixed-pending">
            <p className="small">
              {pending.fixed.length ? t('fixedPending', { amount: money(pending.fixed[0].amount, code), date: at(pending.readyAt) }) : t('fixedPendingRemove', { date: at(pending.readyAt) })}
            </p>
            <button className="link small" onClick={() => run(t('cancelling'), async () => (await cancelPending(chain, wallet, vault), await refresh()))}>
              {t('cancelPendingChange')}
            </button>
          </section>
        )}
        <section className="card" data-testid="fixed-form">
          {suggestion && sameCurrency && (
            <p className="small">
              {t('fixedSuggest', { amount: `${fmtNumber(suggestion.monthly, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${pack!.currency}` })}
              {suggestion.inReserve && suggestion.proposal ? ` ${t('fixedInReserve', { now: pct((snap.rule ?? vault.rule).buckets.reduce((a, b) => a + b.bps, 0)), new: pct(suggestion.proposal.buckets.reduce((a, b) => a + b.bps, 0)) })}` : ''}
            </p>
          )}
          <div className="field">
            <label htmlFor="fixed-monthly">{t('fixedMonthly', { cur: code })}</label>
            <input id="fixed-monthly" data-testid="fixed-monthly" className="input" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value.replace(/[^\d.,]/g, ''))} />
            {!sameCurrency && pack && <span className="tiny muted">{t('fixedCurrency', { cur: code, local: pack.currency })}</span>}
            {value > 0 && kind && kind.kind !== 'Month' && <span className="tiny muted">{t('fixedPerPeriod', { amount: `${fmtNumber(perPeriod, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`, period: word })}</span>}
          </div>
          <p className="tiny muted">{t('fixedHow', { notice: noticeWords(chain.cfg.noticeSecs) })}</p>
          <div className="row" style={{ gap: 8 }}>
            <Button
              small
              testid="fixed-save"
              disabled={!(value > 0)}
              onClick={() =>
                run(t('fixedSigning'), async () => {
                  setHash(await proposeFixedFee(chain, wallet, vault, snap, value, token));
                  if (suggestion?.inReserve && suggestion.proposal) rememberMine(vault, await wallet.signAndSend(chain.client.proposeRuleOp(vault.vault, suggestion.proposal)));
                  await refresh();
                })
              }
            >
              {t('fixedSave', { period: word })}
            </Button>
            {current && (
              <Button
                small
                kind="secondary"
                onClick={() =>
                  run(t('fixedSigning'), async () => {
                    setHash(await proposeFixedFee(chain, wallet, vault, snap, 0, token));
                    await refresh();
                  })
                }
              >
                {t('fixedRemove')}
              </Button>
            )}
          </div>
          {hash && <TxLink hash={hash} />}
        </section>
      </div>
      <Tabs current="settings" />
    </>
  );
}

export function Payout() {
  const { vault, snap, chain, wallet, run, go, refresh } = useApp();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  if (!vault || !wallet || !snap) return null;
  const now = snap.payout ?? vault.owner;
  const pending = snap.pendingPayout;
  const save = () => {
    const a = address.trim().toUpperCase();
    if (!StrKey.isValidEd25519PublicKey(a) && !StrKey.isValidContract(a)) return setError(t('walletsBad'));
    setError('');
    void run(t('payoutSigning'), async () => {
      setHash(await proposePayout(chain, wallet, vault, a));
      setAddress('');
      await refresh();
    });
  };
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('settings')} />
        <h1>{t('payoutTitle')}</h1>
        <p className="muted">{t('payoutSub')}</p>
        <section className="card" data-testid="payout-now">
          <span className="tiny muted">{t('payoutNow')}</span>
          <span className="mono small" title={now} data-testid="payout-address">
            {short(now)} {now === vault.owner ? <span className="muted">{t('payoutSigner')}</span> : null}
          </span>
        </section>
        {pending && pending.readyAt > BigInt(Math.floor(Date.now() / 1000)) && (
          <section className="card info" data-testid="payout-pending">
            <p className="small">{t('payoutPending', { address: short(pending.payout), date: at(pending.readyAt) })}</p>
            <button className="link small" onClick={() => run(t('cancelling'), async () => (await cancelPending(chain, wallet, vault), await refresh()))}>
              {t('cancelPendingChange')}
            </button>
          </section>
        )}
        <section className="card">
          <div className="field">
            <label htmlFor="payout-new">{t('payoutNew')}</label>
            <input id="payout-new" data-testid="payout-new" className="input mono" value={address} placeholder="G…" onChange={(e) => setAddress(e.target.value)} />
          </div>
          {error && (
            <p className="small" role="alert">
              {error}
            </p>
          )}
          <p className="tiny muted">{t('payoutNotice', { notice: noticeWords(chain.cfg.noticeSecs) })}</p>
          <Button small testid="payout-save" disabled={!address.trim()} onClick={save}>
            {t('payoutSave')}
          </Button>
          {hash && <TxLink hash={hash} />}
        </section>
      </div>
      <Tabs current="settings" />
    </>
  );
}
