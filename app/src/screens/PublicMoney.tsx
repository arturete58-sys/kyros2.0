/**
 * Public money: a central bank digital currency (CBDC) or a government's
 * digital dollar on Stellar. The vault accepts it with notice, splits the
 * payments in it like any other, and can pay the tax in it straight to the
 * tax office's own Stellar account. Before choosing it the user sees what its
 * issuer can do (authorization, freezing, clawback), also inside the vault.
 */
import { useState } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { SOVEREIGN_MONEY, sovereignFor, type SovereignMoney } from 'kyros-sdk';
import { addPublicToken, inspectPublicToken, proposeTaxOffice, simulatePublicPayment, type PublicTokenCheck } from '../kyros';
import { countryName } from '../packs';
import { fmtDateTime, t, type Key } from '../i18n';
import { Button, Tabs, Top, TxLink, useApp } from '../ui';
import { noticeWords } from './Move';

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const UNIT = 10_000_000n;

function MoneyCard({ m }: { m: SovereignMoney }) {
  return (
    <section className="card" data-testid="public-money-card">
      <div className="row spread">
        <b>{m.name}</b>
        <span className={`badge ${m.status === 'live' ? 'ok' : m.status === 'announced' ? 'info' : 'warn'}`}>{t(`pmStatus_${m.status}` as Key)}</span>
      </div>
      <span className="tiny muted">
        {countryName(m.country)} · {t(`pmKind_${m.kind}` as Key)}
      </span>
      <p className="small">{t(`pm_${m.id.replace(/-/g, '_')}` as Key)}</p>
      <p className="small muted">{t(`pmFit_${m.id.replace(/-/g, '_')}` as Key)}</p>
      <p className="tiny">
        {m.sources.map((s, i) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
            {i ? ' · ' : ''}
            {t('source')} {i + 1}
          </a>
        ))}
      </p>
    </section>
  );
}

function Controls({ c }: { c: PublicTokenCheck }) {
  if (!c.exists) return <p className="small">{t('pmNotFound')}</p>;
  return (
    <div className="col" style={{ gap: 6 }} data-testid="pm-controls">
      {c.controls.length === 0 && <p className="small">{t('pmNoControls')}</p>}
      {c.controls.map((x) => (
        <p key={x} className="small">
          • {t(`pmControl_${x}` as Key)}
        </p>
      ))}
      {c.toAuthorize.length > 0 && (
        <>
          <p className="small">{c.canAuthorizeHere ? t('pmAuthorizeHere') : t('pmAuthorizeAsk')}</p>
          {c.toAuthorize.map((a) => (
            <span key={a} className="tiny mono" title={a}>
              {a}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

export function PublicMoney() {
  const { vault, snap, chain, wallet, run, go, setVault, refresh } = useApp();
  const [code, setCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [peg, setPeg] = useState<'usd' | 'eur'>('usd');
  const [check, setCheck] = useState<PublicTokenCheck | null>(null);
  const [office, setOffice] = useState('');
  const [error, setError] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  if (!vault || !wallet) return null;
  const home = snap?.pack?.country ?? vault.answers.packId.toUpperCase();
  const mine = sovereignFor(home);
  const others = SOVEREIGN_MONEY.filter((m) => m.country !== home);
  const pm = chain.cfg.publicMoney;
  const accepted = new Set(snap?.acceptedTokens ?? []);
  const pending = snap?.pendingToken && snap.pendingToken.readyAt > BigInt(Math.floor(Date.now() / 1000)) ? snap.pendingToken : null;
  const testAdded = !!pm && (vault.publicTokens ?? []).some((p) => p.contract === pm.contract);
  const add = (c: PublicTokenCheck, tok: { code: string; issuer: string; peg: 'usd' | 'eur'; name?: string }) =>
    run(t('pmAdd'), async (step) => {
      setVault(await addPublicToken(chain, wallet, vault, c, tok, step));
      setCheck(null);
      go('public');
      await refresh();
    });
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('settings')} />
        <h1>{t('pmTitle')}</h1>
        <p className="muted">{t('pmSub')}</p>

        <h2>{t('pmInCountry', { country: countryName(home) })}</h2>
        {mine.length ? mine.map((m) => <MoneyCard key={m.id} m={m} />) : <p className="small muted">{t('pmNoneHere', { country: countryName(home) })}</p>}
        <details>
          <summary className="small">{t('pmElsewhere')}</summary>
          {others.map((m) => (
            <MoneyCard key={m.id} m={m} />
          ))}
        </details>

        {(vault.publicTokens ?? []).length > 0 && (
          <section className="card" data-testid="pm-accepted">
            <p style={{ fontWeight: 600 }}>{t('pmYours')}</p>
            {(vault.publicTokens ?? []).map((p) => (
              <div key={p.contract} className="row spread small">
                <span>
                  {p.name ?? p.code} <span className="tiny muted mono">{short(p.contract)}</span>
                </span>
                {accepted.has(p.contract) ? (
                  <span className="badge ok">{t('pmAccepted')}</span>
                ) : pending?.token === p.contract ? (
                  <span className="badge info">{t('pmPendingUntil', { date: fmtDateTime(new Date(Number(pending.readyAt) * 1000)) })}</span>
                ) : (
                  <span className="badge warn">{t('pmNotAccepted')}</span>
                )}
              </div>
            ))}
            {pm && accepted.has(pm.contract) && (
              <Button
                small
                kind="secondary"
                testid="pm-simulate"
                onClick={() =>
                  run(t('clientPaying'), async () => {
                    setHash(await simulatePublicPayment(chain, vault, 1210n * UNIT));
                    await refresh();
                  })
                }
              >
                {t('pmSimulate', { code: pm.code })}
              </Button>
            )}
            {hash && <TxLink hash={hash} />}
          </section>
        )}

        {pm && !testAdded && (
          <section className="card info" data-testid="pm-test">
            <p style={{ fontWeight: 600 }}>{t('pmTestTitle', { code: pm.code })}</p>
            <p className="small">{t('pmTestBody')}</p>
            <Button
              small
              testid="pm-test-add"
              onClick={() =>
                run(t('pmAdd'), async (step) => {
                  const c = await inspectPublicToken(chain, vault, snap, pm.code, pm.issuer);
                  setVault(await addPublicToken(chain, wallet, vault, c, { code: pm.code, issuer: pm.issuer, peg: 'usd', name: t('pmTestName') }, step));
                  go('public');
                  await refresh();
                })
              }
            >
              {t('pmTestAdd')}
            </Button>
          </section>
        )}

        <section className="card" data-testid="pm-form">
          <p style={{ fontWeight: 600 }}>{t('pmOther')}</p>
          <div className="grid2">
            <label className="field">
              <span className="tiny">{t('pmCode')}</span>
              <input className="input mono" value={code} placeholder="BMD" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))} />
            </label>
            <label className="field">
              <span className="tiny">{t('pmPeg')}</span>
              <select className="input" value={peg} onChange={(e) => setPeg(e.target.value as 'usd' | 'eur')}>
                <option value="usd">USD</option>
                <option value="eur">EUR</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span className="tiny">{t('pmIssuer')}</span>
            <input className="input mono" value={issuer} placeholder="G…" onChange={(e) => setIssuer(e.target.value.trim().toUpperCase())} />
          </label>
          {error && (
            <p className="small" role="alert">
              {error}
            </p>
          )}
          <Button
            small
            kind="secondary"
            disabled={!code || !issuer}
            onClick={() => {
              if (!StrKey.isValidEd25519PublicKey(issuer)) return setError(t('walletsBad'));
              setError('');
              void run(t('pmChecking'), async () => setCheck(await inspectPublicToken(chain, vault, snap, code, issuer)));
            }}
          >
            {t('pmCheck')}
          </Button>
          {check && (
            <>
              <Controls c={check} />
              {check.exists && !check.accepted && (
                <Button small testid="pm-add" onClick={() => add(check, { code, issuer, peg })}>
                  {t('pmAdd')}
                </Button>
              )}
              {check.accepted && <span className="badge ok">{t('pmAccepted')}</span>}
            </>
          )}
          <p className="tiny muted">{t('pmNotice', { notice: noticeWords(chain.cfg.noticeSecs) })}</p>
        </section>

        <section className="card" data-testid="pm-tax-office">
          <p style={{ fontWeight: 600 }}>{t('pmOfficeTitle')}</p>
          <p className="small">{t('pmOfficeBody')}</p>
          {snap?.taxDestination && (
            <p className="tiny muted">
              {t('pmOfficeNow')} <span className="mono">{short(snap.taxDestination)}</span>
            </p>
          )}
          <label className="field">
            <span className="tiny">{t('pmOfficeAddress')}</span>
            <input className="input mono" value={office} placeholder="G…" onChange={(e) => setOffice(e.target.value.trim().toUpperCase())} />
          </label>
          <Button
            small
            kind="secondary"
            disabled={!office}
            onClick={() => {
              if (!StrKey.isValidEd25519PublicKey(office) && !StrKey.isValidContract(office)) return setError(t('walletsBad'));
              setError('');
              void run(t('pmOfficeSigning'), async () => {
                setHash(await proposeTaxOffice(chain, wallet, vault, office));
                setOffice('');
                await refresh();
              });
            }}
          >
            {t('pmOfficeSave')}
          </Button>
          <p className="tiny muted">{t('pmNotice', { notice: noticeWords(chain.cfg.noticeSecs) })}</p>
        </section>
        <p className="tiny muted">{t('pmReviewed')}</p>
      </div>
      <Tabs current="settings" />
    </>
  );
}

/** Settings: the way into public money, with the country's own if it has any. */
export function PublicMoneyLink() {
  const { vault, snap, go } = useApp();
  if (!vault || vault.archivedOf) return null;
  const home = snap?.pack?.country ?? vault.answers.packId.toUpperCase();
  const mine = sovereignFor(home);
  return (
    <button className="card link-card" data-testid="public-money-link" onClick={() => go('public')}>
      <div className="row spread">
        <b>{t('pmTitle')}</b>
        <span aria-hidden>›</span>
      </div>
      <span className="small muted">{mine.length ? t('pmLinkHere', { names: mine.map((m) => m.name).join(', ') }) : t('pmLink')}</span>
    </button>
  );
}

