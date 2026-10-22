/**
 * Changing country: the user picks the new country and the day their tax
 * residence changes; the app shows what changes and what they will sign, then
 * the wallet signs it. Same tax calendar: the vault takes the new rule on the
 * day. Another calendar: a new vault, and the same payment address moves to
 * it; the earlier vault keeps its reserve for the earlier country's taxes.
 */
import { useEffect, useMemo, useState } from 'react';
import type { RulePack } from 'kyros-sdk';
import { cancelMove, canSignMove, currentVault, keepMove, planMove, signMove, viewPrevious, type PendingMove, type Plan, type VaultInfo } from '../kyros';
import { countries, countryName, loadPack } from '../packs';
import { fmtDate, locale, t } from '../i18n';
import { Button, pct, prefill, Tabs, Top, useApp } from '../ui';

const day = (iso: string) => fmtDate(new Date(`${iso}T12:00:00Z`));
const secsDate = (s: string | undefined) => fmtDate(new Date(Number(s ?? '0') * 1000));
const splitText = (r: { vatBps: number; buckets: { bps: number }[] }) => t('splitValue', { vat: pct(r.vatBps), res: pct(r.buckets.reduce((a, b) => a + b.bps, 0)) });

/** "2 minutes", "3 days": the vault's notice in words. */
export function noticeWords(secs: number): string {
  const [n, unit] = secs < 3_600 ? [Math.round(secs / 60), 'minute'] : secs < 172_800 ? [Math.round(secs / 3_600), 'hour'] : [Math.round(secs / 86_400), 'day'];
  return new Intl.NumberFormat(locale(), { style: 'unit', unit, unitDisplay: 'long' }).format(n);
}

export function Move() {
  const { vault, snap, chain, wallet, run, go, setVault, lang } = useApp();
  const all = useMemo(countries, [lang]);
  const today = new Date().toISOString().slice(0, 10);
  const current = vault?.answers.packId ?? '';
  const [packId, setPackId] = useState(() => prefill.move?.country.toLowerCase() ?? all.find((c) => c.id !== current)?.id ?? 'pt');
  const [date, setDate] = useState(() => prefill.move?.date ?? today);
  const [pack, setPack] = useState<RulePack | null>(null);
  const [region, setRegion] = useState<string | undefined>(undefined);
  const [res, setRes] = useState<{ move: PendingMove; plan: Plan; steps: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    delete prefill.move;
  }, []);
  useEffect(() => {
    loadPack(packId).then((p) => {
      setPack(p);
      setRegion(p.regions?.length ? p.regions[0].id : undefined);
    });
  }, [packId]);
  useEffect(() => {
    setRes(null);
    setErr(null);
    if (!vault || !snap || !pack || packId === current || !date) return;
    let live = true;
    planMove(chain, vault, snap, pack, region, date)
      .then(({ move, plan }) => {
        if (!live) return;
        const name = countryName(pack.country);
        const cur = countryName(current.toUpperCase());
        const notice = noticeWords(chain.cfg.noticeSecs);
        const steps =
          move.kind === 'rule'
            ? [...(move.wasFollowing ? [t('moveOpUnfollow', { current: cur })] : []), t('moveOpRule', { country: name, date: day(date), split: splitText(move.rule) })]
            : [t('moveOpVault', { country: name, split: splitText(move.rule) }), ...(vault.abroadInbox ? [t('moveOpAbroad')] : []), t('moveOpInbox', { notice })];
        setRes({ move, plan, steps });
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [vault, snap, pack, packId, region, date, chain, current]);
  if (!vault || !wallet) return null;
  const name = pack ? countryName(pack.country) : '';
  const cur = countryName(current.toUpperCase());
  const m = res?.move;
  const now = m ? canSignMove(m) : false;
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('settings')} />
        <h1>{t('changeCountry')}</h1>
        <p className="muted">{t('moveSub')}</p>
        <div className="field">
          <label htmlFor="move-country">{t('moveCountry')}</label>
          <select id="move-country" data-testid="move-country" className="input" value={packId} onChange={(e) => setPackId(e.target.value)}>
            {all.map((c) => (
              <option key={c.id} value={c.id} disabled={c.id === current}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {pack?.regions?.length ? (
          <div className="field">
            <label htmlFor="move-region">{t('region')}</label>
            <select id="move-region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
              {pack.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name ?? r.id}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="move-date">{t('moveDate')}</label>
          <input id="move-date" data-testid="move-date" className="input" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
          <span className="tiny muted">{t('moveDateHelp')}</span>
        </div>
        {err && <p className="small">{err}</p>}
        {m && res && (
          <section className="card" data-testid="move-plan">
            <div className="row spread small">
              <span>{t('split')}</span>
              <b>{splitText(m.rule)}</b>
            </div>
            <p className="small">{m.kind === 'rule' ? t('moveSameCal') : t('moveNewCal', { country: name, current: cur })}</p>
            {m.kind === 'vault' && !now && <p className="small">{t('moveSignFrom', { notice: noticeWords(chain.cfg.noticeSecs), date: secsDate(m.signFrom) })}</p>}
            <p className="small" style={{ fontWeight: 600 }}>
              {t('moveWillSign')}
            </p>
            <ol className="steps-list small" data-testid="move-steps">
              {res.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="tiny muted">{t('moveTestnetDest')}</p>
          </section>
        )}
        <Button
          testid="move-sign"
          disabled={!m}
          onClick={() =>
            m &&
            run(t('moveSigning'), async (step) => {
              const next = now ? await signMove(chain, wallet, vault, m, step) : keepMove(vault, m);
              setVault(next);
            })
          }
        >
          {now ? t('moveSignBtn') : t('moveSaveBtn')}
        </Button>
      </div>
      <Tabs current="settings" />
    </>
  );
}

/** Home and Settings: a move planned or signed, until it takes effect. */
export function MoveCard() {
  const { vault, chain, wallet, run, setVault, go } = useApp();
  if (!vault?.move || vault.archivedOf || !wallet) return null;
  const m = vault.move;
  const name = countryName(m.packId.toUpperCase());
  const ready = canSignMove(m);
  const text = m.signedAt
    ? t('movePendingSigned', { country: name, date: m.kind === 'rule' ? day(m.date) : secsDate(m.readyAt) })
    : ready
      ? t('movePendingReady', { country: name, date: day(m.date) })
      : t('movePendingWait', { country: name, date: day(m.date), from: secsDate(m.signFrom) });
  return (
    <section className="card info" data-testid="move-card">
      <p className="small" style={{ fontWeight: 600 }}>
        {text}
      </p>
      <div className="row" style={{ gap: 8 }}>
        {!m.signedAt && ready && (
          <Button small testid="move-card-sign" onClick={() => run(t('moveSigning'), async (step) => setVault(await signMove(chain, wallet, vault, m, step)))}>
            {t('moveSignBtn')}
          </Button>
        )}
        <Button small kind="secondary" testid="move-cancel" onClick={() => run(t('moveCancelling'), async () => setVault(await cancelMove(chain, wallet, vault)))}>
          {t('moveCancelBtn')}
        </Button>
        {!m.signedAt && (
          <button className="link small" onClick={() => go('move')}>
            {t('changeCountry')}
          </button>
        )}
      </div>
    </section>
  );
}

/** Settings: the vaults of earlier countries, still paying those taxes. */
export function PreviousVaults() {
  const { vault, setVault } = useApp();
  const cur = vault ? currentVault(vault) : null;
  if (!vault || !cur?.previous?.length) return null;
  return (
    <>
      <h2>{t('previousVaults')}</h2>
      <div className="card" data-testid="previous-vaults">
        <p className="small muted">{t('previousSub')}</p>
        {cur.previous.map((p: VaultInfo) => (
          <div className="row spread small" key={p.vault}>
            <span>
              {countryName(p.answers.packId.toUpperCase())} · <span className="muted">{splitText(p.rule)}</span>
            </span>
            {vault.vault === p.vault ? null : (
              <button className="link small" onClick={() => setVault(viewPrevious(cur, p))}>
                {t('previousOpen')}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Home: shown while the app shows an earlier vault. */
export function ArchivedBanner() {
  const { vault, setVault } = useApp();
  if (!vault?.archivedOf) return null;
  const cur = currentVault(vault);
  return (
    <section className="card warn" data-testid="archived-banner">
      <p className="small">{t('viewingPrevious', { country: countryName(vault.answers.packId.toUpperCase()) })}</p>
      {cur && (
        <button className="link small" onClick={() => setVault(cur)}>
          {t('backToCurrent')}
        </button>
      )}
    </section>
  );
}
