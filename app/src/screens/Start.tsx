import { useEffect, useMemo, useState } from 'react';
import { regimeChoices, split, type ActivityId, type ClientKind, type RulePack } from 'kyros-sdk';
import { countries, countryName, loadPack } from '../packs';
import { createVault, followLaw, makePlan, money, type Answers } from '../kyros';
import { fmtNumber, t, type Key } from '../i18n';
import { Button, LangPicker, Option, pct, Seg, Toggle, Top, useApp } from '../ui';
import { Logo } from '../brand';

export const ACTIVITIES: ActivityId[] = ['software', 'consulting', 'creative', 'web3', 'ecommerce', 'education', 'health', 'books', 'hospitality'];
export const CLIENTS: ClientKind[] = ['business-local', 'consumer-local', 'business-eu', 'abroad'];

/** [title, subtitle] of an activity, in the user's language. */
export const activityText = (a: ActivityId): [string, string] => [t(`act_${a}` as Key), t(`act_${a}_s` as Key)];
export const clientText = (c: ClientKind): [string, string] => {
  const k = `cl_${c.replace('-', '_')}`;
  return [t(k as Key), t(`${k}_s` as Key)];
};

const PRECISION_TONE: Record<string, string> = { exact: 'ok', presumptive: 'info', 'exact-on-profit': 'info', estimate: 'warn', none: 'warn' };
const precisionText = (p: string): [string, string] => [t((`prec_${p}` in PRECISION_TONE ? `prec_${p}` : 'prec_estimate') as Key), PRECISION_TONE[p] ?? 'warn'];

export function vatLabel(treatment: string, bps: number, name = t('vat')): string {
  switch (treatment) {
    case 'standard':
      return t('vatStd', { name, pct: pct(bps) });
    case 'reduced':
      return t('vatReduced', { name, pct: pct(bps) });
    case 'exempt':
      return t('vatExempt', { name });
    case 'reverse-charge':
      return t('vatReverse', { name });
    case 'outside-scope':
      return t('vatOutside', { name });
    default:
      return t('vatNone', { name });
  }
}

/** What Kyros does, shown rather than told: one payment, split on arrival. */
function SplitPreview() {
  const n = (x: number) => fmtNumber(x, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <figure className="preview" aria-label={t('previewPaid')}>
      <div className="preview-head">
        <span className="small muted">{t('previewPaid')}</span>
        <span className="preview-amount">
          {n(1210)} <small>USDC</small>
        </span>
      </div>
      <div className="split grow-in" aria-hidden>
        <span className="y" style={{ flexGrow: 800 }} />
        <span className="v" style={{ flexGrow: 210 }} />
        <span className="i" style={{ flexGrow: 200 }} />
      </div>
      <ul className="preview-rows">
        <li>
          <span className="dot" style={{ background: 'var(--yours)' }} />
          <span className="grow">{t('previewYours')}</span>
          <b>{n(800)}</b>
        </li>
        <li>
          <span className="dot" style={{ background: 'var(--vat)' }} />
          <span className="grow">{t('previewVat')}</span>
          <b>{n(210)}</b>
        </li>
        <li>
          <span className="dot" style={{ background: 'var(--income)' }} />
          <span className="grow">{t('previewIncome')}</span>
          <b>{n(200)}</b>
        </li>
      </ul>
      <figcaption className="tiny muted">{t('previewLocked')}</figcaption>
    </figure>
  );
}

export function Welcome() {
  const { chain, setWallet, run } = useApp();
  const [name, setName] = useState('');
  // The passkey code is loaded while this screen shows, so it is ready when Face ID is tapped.
  useEffect(() => {
    void import('../wallet/passkey');
  }, []);
  const passkey = () => import('../wallet/passkey');
  const start = (f: () => Promise<import('../wallet/types').Wallet>, title: string) =>
    run(title, async (step) => {
      step(t('waitingFaceId'));
      const w = await f();
      setWallet(w);
      return w;
    });
  return (
    <>
      <div className="content welcome">
        <div className="welcome-top">
          <Logo size={34} />
          <LangPicker compact />
        </div>
        <div className="hero">
          <h1 className="display">{t('heroTitle')}</h1>
          <p className="lead muted">{t('heroSub')}</p>
        </div>
        <SplitPreview />
        <p className="trust small">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
            <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
          </svg>
          <span dangerouslySetInnerHTML={{ __html: t('yourMoney') }} />
        </p>
        <div className="field">
          <label htmlFor="name">{t('nameForPasskey')}</label>
          <input id="name" className="input" value={name} placeholder="Lucía" onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="tiny muted">{t('walletList')}</p>
        <p className="tiny muted">{t('testnetNote')}</p>
      </div>
      <div className="footer">
        <Button testid="connect-wallet" onClick={() => start(async () => (await import('../wallet/classic')).connectClassicWallet(chain), t('connectingWallet'))}>
          {t('connectWallet')}
        </Button>
        <Button kind="secondary" testid="create-passkey" onClick={() => start(async () => (await passkey()).createPasskeyWallet(chain, name.trim() || 'Kyros'), t('creatingWallet'))}>
          {t('createFaceId')}
        </Button>
        <button className="link" data-testid="connect-passkey" style={{ textAlign: 'center', padding: '6px 8px 0' }} onClick={() => start(async () => (await passkey()).connectPasskeyWallet(chain), t('enteringFaceId'))}>
          {t('haveAccount')}
        </button>
      </div>
    </>
  );
}

export function Onboarding() {
  const { chain, wallet, setVault, run, lang } = useApp();
  const all = useMemo(countries, [lang]);
  const [step, setStep] = useState(1);
  const [packId, setPackId] = useState('es');
  const [pack, setPack] = useState<RulePack | null>(null);
  const [region, setRegion] = useState<string | undefined>('MD');
  const [resident, setResident] = useState<Answers['resident']>('yes');
  const [activity, setActivity] = useState<ActivityId>('software');
  const [client, setClient] = useState<ClientKind>('business-local');
  const [revenue, setRevenue] = useState('45000');
  const [follow, setFollow] = useState(true);
  const [regime, setRegime] = useState<string | undefined>(undefined);
  const regimes = useMemo(() => (pack ? regimeChoices(pack) : []), [pack]);

  useEffect(() => {
    loadPack(packId).then((p) => {
      setPack(p);
      setRegion(p.regions?.length ? p.regions.find((r) => r.id === 'MD')?.id ?? p.regions[0].id : undefined);
      setRegime(undefined);
    });
  }, [packId]);

  const answers: Answers = { packId, region, resident, activity, client, revenue: Number(revenue) || 0, ...(regime ? { regime } : {}) };
  const plan = useMemo(() => (pack && step === 4 ? makePlan(pack, answers) : null), [pack, step, packId, region, activity, client, revenue, regime]);

  if (step === 1)
    return (
      <>
        <div className="content">
          <Top step={1} />
          <h1>{t('q1')}</h1>
          <p className="muted">{t('q1Sub')}</p>
          <div className="field">
            <label htmlFor="country">{t('country')}</label>
            <select id="country" className="input" value={packId} onChange={(e) => setPackId(e.target.value)}>
              {all.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {pack?.regions?.length ? (
            <div className="field">
              <label htmlFor="region">{t('region')}</label>
              <select id="region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
                {pack.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name ?? r.id}
                  </option>
                ))}
              </select>
              <span className="tiny muted">{t('regionNote')}</span>
            </div>
          ) : null}
          <div className="card">
            <p className="small" style={{ fontWeight: 500 }}>
              {t('days183')}
            </p>
            <Seg value={resident} onChange={setResident} options={[['yes', t('yes')], ['no', t('no')], ['unsure', t('unsure')]]} />
            {resident !== 'yes' && (
              <p className="tiny muted">{t('residenceHelp')}</p>
            )}
          </div>
        </div>
        <div className="footer">
          <Button testid="next-1" onClick={() => setStep(2)} disabled={!pack}>
            {t('continue')}
          </Button>
        </div>
      </>
    );

  if (step === 2)
    return (
      <>
        <div className="content">
          <Top onBack={() => setStep(1)} step={2} />
          <h1>{t('q2')}</h1>
          <p className="muted">{t('q2Sub')}</p>
          {ACTIVITIES.map((a) => (
            <Option key={a} testid={`activity-${a}`} on={activity === a} title={activityText(a)[0]} sub={activityText(a)[1]} onClick={() => setActivity(a)} />
          ))}
        </div>
        <div className="footer">
          <Button testid="next-2" onClick={() => setStep(3)}>
            {t('continue')}
          </Button>
        </div>
      </>
    );

  if (step === 3)
    return (
      <>
        <div className="content">
          <Top onBack={() => setStep(2)} step={3} />
          <h1>{t('q3')}</h1>
          <p className="muted">{t('q3Sub')}</p>
          {CLIENTS.map((k) => (
            <Option key={k} testid={`client-${k}`} on={client === k} title={clientText(k)[0]} sub={clientText(k)[1]} onClick={() => setClient(k)} />
          ))}
          {regimes.length > 0 && (
            <>
              <h2>{t('regimeQ')}</h2>
              <Option testid="regime-general" on={!regime} title={t('regimeAuto')} sub={t('regimeAutoSub', { vat: pack?.vatName ?? t('vat') })} onClick={() => setRegime(undefined)} />
              {regimes.map((r) => (
                <Option key={r.id} testid={`regime-${r.id}`} on={regime === r.id} title={r.label.split(':')[0]} sub={t('regimeSub', { vat: pack?.vatName ?? t('vat') })} onClick={() => setRegime(r.id)} />
              ))}
            </>
          )}
          <div className="field">
            <label htmlFor="revenue">{t('revenueQ', { cur: pack?.currency ?? 'EUR' })}</label>
            <input id="revenue" className="input" inputMode="numeric" value={revenue} onChange={(e) => setRevenue(e.target.value.replace(/[^\d]/g, ''))} />
            <span className="tiny muted">{t('revenueNote')}</span>
          </div>
        </div>
        <div className="footer">
          <Button testid="next-3" onClick={() => setStep(4)}>
            {t('seePlan')}
          </Button>
        </div>
      </>
    );

  if (!plan || !pack) return null;
  const s = plan.setup;
  const base = 1000n * 10_000_000n;
  const gross = base + (base * BigInt(plan.rule.vatBps)) / 10_000n;
  const ex = split(plan.rule, gross);
  const reserveOnly = ex.reserve - ex.vat;
  const w = (x: bigint) => `${Number((x * 1000n) / (gross || 1n)) / 10}%`;
  const [precLabel, precTone] = precisionText(s.precision);
  const canFollow = s.vat.treatment === 'standard';
  return (
    <>
      <div className="content">
        <Top onBack={() => setStep(3)} />
        <h1>{t('planReady')}</h1>
        <p className="muted">{t('planSub')}</p>
        <div className="card">
          <p className="small muted">{t('ifPaid', { amount: money(gross) })}</p>
          <div className="bar">
            <span style={{ width: w(ex.net), background: 'var(--spend)' }} />
            {ex.vat > 0n && <span style={{ width: w(ex.vat), background: 'var(--tax)' }} />}
            {reserveOnly > 0n && <span style={{ width: w(reserveOnly), background: 'var(--warn)' }} />}
          </div>
          <div className="row">
            <span className="dot" style={{ background: 'var(--spend)' }} />
            <span className="grow">{t('forYou')}</span>
            <b>{money(ex.net)}</b>
          </div>
          <div className="row">
            <span className="dot" style={{ background: 'var(--tax)' }} />
            <span className="grow">
              {vatLabel(s.vat.treatment, s.vat.bps, pack.vatName ?? t('vat'))} <span className="badge ok">{t('exact')}</span>
            </span>
            <b>{money(ex.vat)}</b>
          </div>
          <div className="row">
            <span className="dot" style={{ background: 'var(--warn)' }} />
            <span className="grow">
              {t('incomeReserve', { pct: pct(s.reserveBps) })} <span className={`badge ${precTone}`}>{precLabel}</span>
            </span>
            <b>{money(reserveOnly)}</b>
          </div>
        </div>
        <div className="card info">
          <p className="small" style={{ fontWeight: 600, color: 'var(--primary)' }}>
            {t('whyPct', { pct: pct(s.reserveBps) })}
          </p>
          <p className="small">
            {t('whyBody', {
              place: countryName(pack.country) + (region ? ` (${pack.regions?.find((r) => r.id === region)?.name ?? region})` : ''),
              revenue: fmtNumber(Number(revenue)),
              cur: pack.currency,
              margin: s.precision !== 'none' ? t('whyMargin') : '',
            })}
          </p>
        </div>
        {canFollow && (
          <div className="card">
            <div className="row">
              <div className="grow">
                <p style={{ fontWeight: 500 }}>{t('followLaw')}</p>
                <p className="small muted">{t('followLawSub')}</p>
              </div>
              <Toggle on={follow} onClick={() => setFollow(!follow)} label={t('followLaw')} />
            </div>
          </div>
        )}
      </div>
      <div className="footer">
        <Button
          testid="create-vault"
          onClick={() =>
            run(t('creatingVault'), async (step) => {
              const v = await createVault(chain, wallet!, plan, answers, step);
              if (follow && canFollow) {
                step(t('stepFollow'));
                try {
                  await followLaw(chain, wallet!, v, pack.country);
                } catch {
                  /* the vault works without it; the user can turn it on in Ajustes */
                }
              }
              setVault(v);
            })
          }
        >
          {t('createVault')}
        </Button>
      </div>
    </>
  );
}
