import { useEffect, useState } from 'react';
import { type PeriodKind, formatAmount, payableUnits, requestTotals, taxToolCsv, TAX_TOOLS, toCsv, money as cents, type PaymentRequest, type TaxTool } from 'kyros-sdk';
import { convertNow, expectPayment, followLaw, money, payBucket, proposeEuroReserve, releaseDue, simulateClientPayment, type Held } from '../kyros';
import { countryName } from '../packs';
import { Deadlines, NoticeReader, ScheduledList, deadlineLabel } from './Taxes';
import { Button, LangPicker, pct, Tabs, Toggle, Top, TxLink, useApp } from '../ui';
import { activityText, clientText } from './Start';
import { fmtDate as fmtDay, fmtDateTime, fmtTime, locale, t, type Key } from '../i18n';

const UNIT = 10_000_000n;
const bucketLabel = (b: string) => t(b === 'vat' ? 'bucketVat' : 'bucketIncome');
const fmtDate = (secs: bigint) => fmtDay(new Date(Number(secs) * 1000));

/** The payment address: what the user shares so that every payment splits itself. */
function PayAddress() {
  const { vault, go } = useApp();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!vault) return;
    import('qrcode').then((q) => q.toDataURL(vault.inbox, { margin: 1, width: 240 }).then(setQr)).catch(() => setQr(null));
  }, [vault?.inbox]);
  if (!vault) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(vault.inbox);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the address is selectable below */
    }
  };
  const share = () => navigator.share?.({ title: 'Kyros', text: t('shareText', { address: vault.inbox }) }).catch(() => {});
  return (
    <div className="card" data-testid="pay-address">
      <div className="row spread">
        <span style={{ fontWeight: 600 }}>{t('payAddress')}</span>
        <span className="badge ok">{t('automatic')}</span>
      </div>
      <p className="small muted">{t('payAddressSub')}</p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {qr && <img src={qr} alt={t('payAddress')} width={112} height={112} style={{ borderRadius: 8, flex: 'none' }} />}
        <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <span className="tiny mono" style={{ wordBreak: 'break-all' }}>
            {vault.inbox}
          </span>
          <div className="row">
            <Button small kind="secondary" onClick={copy}>
              {copied ? t('copied') : t('copy')}
            </Button>
            {'share' in navigator && (
              <Button small kind="secondary" onClick={share}>
                {t('share')}
              </Button>
            )}
          </div>
        </div>
      </div>
      <button className="link small" data-testid="request" onClick={() => go('request')}>
        {t('specialPayment')}
      </button>
    </div>
  );
}

export function Home() {
  const { snap, vault, wallet, chain, run, refresh, go } = useApp();
  const [lastTx, setLastTx] = useState<string | null>(null);
  if (!vault || !wallet) return null;
  const s = snap;
  const reservedEur = s?.reserved.eur ?? 0n;
  const reservedUsd = s?.reserved.usd ?? 0n;
  const vat = Object.entries(s?.buckets ?? {}).find(([k]) => k === 'vat')?.[1];
  const other = Object.entries(s?.buckets ?? {}).filter(([k]) => k !== 'vat');
  const otherUsd = other.reduce((a, [, v]) => a + v.usd, 0n);
  const otherEur = other.reduce((a, [, v]) => a + v.eur, 0n);
  const received = (s?.events ?? []).filter((e) => e.kind === 'received').slice(0, 4);
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>{t('hello')}</h1>
          <p className="small muted">
            {countryName(vault.answers.packId.toUpperCase())} · {activityText(vault.answers.activity)[0]} · {wallet.label}
          </p>
        </div>
        <div className="card hero" data-testid="spendable">
          <span className="label small">{t('canSpend')}</span>
          <span className="big">{money(s?.spendable.usd ?? 0n)} USDC</span>
          {(s?.spendable.eur ?? 0n) > 0n && <span className="small">{t('andEur', { amount: money(s!.spendable.eur) })}</span>}
          <span className="note small">{t('canSpendNote')}</span>
        </div>
        <div className="card" data-testid="reserved">
          <div className="row spread">
            <span className="small muted">
              {t('setAside')}
              {reservedEur > 0n ? t('inEuros') : ''}
            </span>
            <span className="badge ok">{t('onTrack')}</span>
          </div>
          <span className="amount">
            {reservedEur > 0n ? `${money(reservedEur)} €` : ''}
            {reservedEur > 0n && reservedUsd > 0n ? ' + ' : ''}
            {reservedUsd > 0n || reservedEur === 0n ? `${money(reservedUsd)} USDC` : ''}
          </span>
          <div className="row small muted">
            <span className="dot" style={{ background: 'var(--tax)' }} /> {t('vat')} {money((vat?.usd ?? 0n) + (vat?.eur ?? 0n))}
            <span className="dot" style={{ background: 'var(--warn)', marginLeft: 12 }} /> {t('incomeTax')} {money(otherUsd + otherEur)}
          </div>
          <div className="row spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <span className="small muted">{s?.deadlines?.[0] ? t('nextDeadline', { what: deadlineText(s.deadlines[0]), date: fmtDay(new Date(`${s.deadlines[0].date}T12:00:00Z`)) }) : ''}</span>
            <Button small onClick={() => go('pay')}>
              {t('pay')}
            </Button>
          </div>
        </div>
        <PayAddress />
        {received.length > 0 && (
          <div className="list">
            <h2>{t('lastPayments')}</h2>
            {received.map((e) => (
              <div className="item" key={e.txHash}>
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{t('paymentOf', { amount: formatAmount(e.gross ?? 0n) })}</div>
                  <div className="small muted">{fmtDateTime(new Date(e.closedAt))}</div>
                </div>
                <b>+{money(e.net ?? 0n)}</b>
              </div>
            ))}
          </div>
        )}
        <div className="card warn">
          <p className="small" style={{ fontWeight: 600 }}>
            {t('tryPayment')} <span className="badge warn">Testnet</span>
          </p>
          <p className="small muted">{t('tryPaymentSub')}</p>
          <Button
            kind="secondary"
            small
            testid="simulate-payment"
            onClick={() =>
              run(t('clientPaying'), async (step) => {
                step(t('stepClient'));
                const h = await simulateClientPayment(chain, vault.vault, 1210n * UNIT);
                setLastTx(h);
                step(t('stepReading'));
                await refresh();
              })
            }
          >
            {t('simulate1210')}
          </Button>
          {lastTx && <TxLink hash={lastTx} />}
        </div>
      </div>
      <Tabs current="home" />
    </>
  );
}

export function Request() {
  const { vault, chain, wallet, run, go, refresh } = useApp();
  const [client, setClient] = useState('Acme Software SL');
  const [number, setNumber] = useState(`2026A-${String(Math.floor(Math.random() * 900) + 100)}`);
  const [base, setBase] = useState('1000');
  const isEsBusiness = vault?.answers.packId === 'es' && vault?.answers.client === 'business-local';
  const [withhold, setWithhold] = useState(isEsBusiness);
  const [done, setDone] = useState<{ ref: string; hash: string; payable: bigint } | null>(null);
  if (!vault || !wallet) return null;
  const vatBps = vault.rule.vatBps;
  const req: PaymentRequest = {
    invoiceNumber: number,
    currency: 'EUR',
    withholding: withhold ? { rate: '15' } : undefined,
    payTo: { address: vault.vault, asset: 'USDC' },
    lines: [{ description: t('invoiceTo', { number, client }), quantity: '1', unitPrice: base || '0', vatRate: String(vatBps / 100) }],
  };
  let tot: ReturnType<typeof requestTotals> | null = null;
  try {
    tot = requestTotals(req);
  } catch {
    tot = null;
  }
  const reserveBps = vault.rule.buckets.reduce((a, b) => a + b.bps, 0);
  const bucket = vault.rule.buckets[0]?.name ?? 'income_tax';
  return (
    <>
      <div className="content">
        <Top onBack={() => go('home')} />
        <h1>{t('requestTitle')}</h1>
        {!done && <p className="muted">{t('specialSub')}</p>}
        {!done ? (
          <>
            <div className="field">
              <label>{t('client')}</label>
              <input className="input" value={client} onChange={(e) => setClient(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('invoiceNo')}</label>
              <input className="input" value={number} onChange={(e) => setNumber(e.target.value)} />
            </div>
            <div className="field">
              <label>{t('amountNoVat')}</label>
              <input className="input" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
            </div>
            {tot && (
              <div className="card">
                <div className="row spread small">
                  <span className="muted">{t('base')}</span>
                  <b>{cents(tot.net)} €</b>
                </div>
                <div className="row spread small">
                  <span className="muted">
                    {t('vat')} {pct(vatBps)} <span className="badge ok">{t('automatic')}</span>
                  </span>
                  <b>{cents(tot.tax)} €</b>
                </div>
                <div className="row spread small">
                  <span className="muted">{t('withholding15')}</span>
                  <Toggle on={withhold} onClick={() => setWithhold(!withhold)} label={t('withholding15')} />
                </div>
                {withhold && (
                  <div className="row spread small">
                    <span className="muted">{t('withheld')}</span>
                    <b>−{cents(tot.withheld)} €</b>
                  </div>
                )}
                <div className="row spread">
                  <b>{t('willPay')}</b>
                  <span className="amount" style={{ fontSize: 20 }}>
                    {cents(tot.payable)} €
                  </span>
                </div>
              </div>
            )}
            <div className="card info">
              <p className="small">{t('ownInvoiceNote')}</p>
            </div>
          </>
        ) : (
          <>
            <div className="card ok">
              <p style={{ fontWeight: 600 }}>{t('registered')}</p>
              <p className="small">{t('registeredBody', { number, wh: withhold ? t('andWithholding') : '' })}</p>
              <TxLink hash={done.hash} />
            </div>
            <div className="field">
              <label>{t('payLinkLabel')}</label>
              <input className="input mono" readOnly value={`${location.origin}${import.meta.env.BASE_URL}#pagar?v=${vault.vault}&r=${done.ref}&a=${done.payable}`} onFocus={(e) => e.currentTarget.select()} />
            </div>
          </>
        )}
      </div>
      <div className="footer">
        {!done ? (
          <Button
            testid="register-request"
            disabled={!tot || tot.net <= 0n}
            onClick={() =>
              run(t('registering'), async (step) => {
                step(t('confirmWallet'));
                const r = await expectPayment(chain, wallet, vault.vault, req, reserveBps, bucket);
                setDone({ ref: Buffer.from(r.reference).toString('hex'), hash: r.hash, payable: payableUnits(req) });
              })
            }
          >
            {t('registerAndLink')}
          </Button>
        ) : (
          <>
            <Button
              testid="simulate-request-payment"
              onClick={() =>
                run(t('clientPayingInvoice'), async () => {
                  await simulateClientPayment(chain, vault.vault, done.payable, Buffer.from(done.ref, 'hex'));
                  await refresh();
                  go('home');
                })
              }
            >
              {t('simulateClientPays')}
            </Button>
            <Button kind="secondary" onClick={() => navigator.clipboard?.writeText(`${location.origin}${import.meta.env.BASE_URL}#pagar?v=${vault.vault}&r=${done.ref}&a=${done.payable}`)}>
              {t('copyLink')}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/** "3T 2026", "octubre 2026", "2026" or "2026 · 1/2" for a period of the vault. */
export function periodText(kind: PeriodKind | null, id: number): string {
  if (!kind) return String(id);
  switch (kind.kind) {
    case 'Quarter':
      return t('periodQ', { q: (id % 4) + 1, y: Math.floor(id / 4) });
    case 'Month':
      return new Date(Date.UTC(Math.floor(id / 12), id % 12, 1)).toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
    case 'Year':
      return String(id);
    case 'Months': {
      const per = 12 / kind.months;
      return t('periodPart', { i: (id % per) + 1, n: per, y: Math.floor(id / per) });
    }
    default:
      return `#${id}`;
  }
}

const dueDay = (secs: bigint) => fmtDay(new Date(Number(secs - 1n) * 1000));
const deadlineText = deadlineLabel;

export function Pay() {
  const { vault, snap, chain, wallet, run, go, refresh } = useApp();
  const [hashes, setHashes] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  if (!vault || !wallet) return null;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const held = snap?.held ?? [];
  const vatRows = held.filter((h) => h.bucket === 'vat');
  const key = (h: Held) => `${h.period}|${h.bucket}|${h.token}`;
  const cur = (h: Held) => (h.which === 'eur' ? 'EURC' : 'USDC');
  const payOne = (h: Held) =>
    run(t('paying'), async (step) => {
      const raw = amounts[key(h)];
      const amount = raw ? BigInt(Math.round(Number(raw.replace(',', '.')) * 1e7)) : h.amount;
      if (amount <= 0n || amount > h.amount) throw new Error(t('badAmount', { max: money(h.amount) }));
      step(t('payingBucket', { what: bucketLabel(h.bucket), cur: cur(h) }));
      setHashes([await payBucket(chain, wallet, vault, h, amount)]);
      await refresh();
    });
  return (
    <>
      <div className="content">
        <Top onBack={() => go('home')} />
        <h1>{t('payTaxes')}</h1>
        <p className="muted">{t('paySub')}</p>
        <Deadlines />
        <NoticeReader />
        <ScheduledList />
        <div className="card">
          <p style={{ fontWeight: 600 }}>{t('setAsideByTax')}</p>
          {held.length === 0 && <p className="small muted">{t('nothingYet')}</p>}
          {held.map((h) => {
            const past = h.dueAt > 0n && h.dueAt <= now;
            return (
              <div key={key(h)} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="row spread">
                  <span>
                    {bucketLabel(h.bucket)} · {periodText(snap?.periodKind ?? null, h.period)}
                  </span>
                  <b>
                    {money(h.amount)} {cur(h)}
                  </b>
                </div>
                <span className={`tiny ${past ? '' : 'muted'}`}>
                  {h.dueAt > 0n ? (past ? t('pastDue', { date: dueDay(h.dueAt) }) : `${t('payBefore', { date: dueDay(h.payBy) })}${h.payBy !== h.dueAt ? ` · ${t('lockOn', { date: dueDay(h.dueAt) })}` : ''}`) : ''}
                </span>
                <div className="row">
                  <input
                    className="input"
                    style={{ flex: 1, minHeight: 38, padding: '6px 10px' }}
                    inputMode="decimal"
                    aria-label={t('amount')}
                    placeholder={money(h.amount)}
                    value={amounts[key(h)] ?? ''}
                    onChange={(e) => setAmounts({ ...amounts, [key(h)]: e.target.value.replace(/[^\d.,]/g, '') })}
                  />
                  <Button small onClick={() => payOne(h)}>
                    {t('pay')}
                  </Button>
                  {past && (
                    <Button
                      small
                      kind="secondary"
                      onClick={() =>
                        run(t('releasing'), async () => {
                          setHashes([await releaseDue(chain, wallet, vault, h)]);
                          await refresh();
                        })
                      }
                    >
                      {t('release')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <h2>{t('howPaid')}</h2>
        <div className="list">
          <div className="item small">{t('how1')}</div>
          <div className="item small">{t('how2')}</div>
          <div className="item small">{t('how3')}</div>
        </div>
        <div className="card warn">
          <p className="small">{t('testnetDestination')}</p>
        </div>
        {hashes.map((h) => (
          <TxLink key={h} hash={h} />
        ))}
      </div>
      <div className="footer">
        <Button
          testid="pay-taxes"
          disabled={vatRows.length === 0}
          onClick={() =>
            run(t('paying'), async (step) => {
              const hs: string[] = [];
              for (const h of vatRows) {
                step(t('payingBucket', { what: `${bucketLabel(h.bucket)} ${periodText(snap?.periodKind ?? null, h.period)}`, cur: cur(h) }));
                hs.push(await payBucket(chain, wallet, vault, h, h.amount));
              }
              setHashes(hs);
              await refresh();
            })
          }
        >
          {t('payVatAll')}
        </Button>
      </div>
    </>
  );
}

export function Settings() {
  const { vault, snap, chain, wallet, run, refresh, setWallet, setVault } = useApp();
  if (!vault || !wallet) return null;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const euroActive = !!snap?.conversion;
  const euroPending = snap?.pendingConversionAt && snap.pendingConversionAt > now ? snap.pendingConversionAt : null;
  const reserveBps = vault.rule.buckets.reduce((a, b) => a + b.bps, 0);
  return (
    <>
      <div className="content" style={{ gap: 10 }}>
        <h1>{t('settings')}</h1>
        <LangPicker />
        <h2 className="tiny muted">{t('yourSituation')}</h2>
        <div className="card" style={{ gap: 6 }}>
          <div className="row spread small">
            <span>{t('country')}</span>
            <span className="muted">{countryName(vault.answers.packId.toUpperCase())}</span>
          </div>
          <div className="row spread small">
            <span>{t('activity')}</span>
            <span className="muted">{activityText(vault.answers.activity)[0]}</span>
          </div>
          <div className="row spread small">
            <span>{t('clients')}</span>
            <span className="muted">{clientText(vault.answers.client)[0]}</span>
          </div>
          <div className="row spread small">
            <span>{t('split')}</span>
            <span className="muted">
              {t('splitValue', { vat: pct(vault.rule.vatBps), res: pct(reserveBps) })}
            </span>
          </div>
        </div>
        <h2 className="tiny muted">{t('eurosAndLaw')}</h2>
        <div className="card">
          <div className="row">
            <div className="grow">
              <p style={{ fontWeight: 500 }}>{t('keepEuros')}</p>
              <p className="small muted">
                {euroActive
                  ? t('eurosOn')
                  : euroPending
                    ? t('eurosPending', { time: fmtTime(new Date(Number(euroPending) * 1000)) })
                    : t('eurosOff')}
              </p>
            </div>
            <Toggle
              on={euroActive || !!euroPending}
              disabled={euroActive || !!euroPending || !chain.cfg.conversion}
              label={t('keepEuros')}
              onClick={() =>
                run(t('turningEuros'), async () => {
                  await proposeEuroReserve(chain, wallet, vault);
                  await refresh();
                })
              }
            />
          </div>
          {euroActive && (snap?.reserved.usd ?? 0n) > 0n && (
            <Button
              kind="secondary"
              small
              onClick={() =>
                run(t('converting'), async () => {
                  await convertNow(chain, vault, snap!.period);
                  await refresh();
                })
              }
            >
              {t('convertNow', { amount: money(snap!.reserved.usd) })}
            </Button>
          )}
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="grow">
              <p style={{ fontWeight: 500 }}>{t('followLaw')}</p>
              <p className="small muted">{snap?.feed ? t('followsLaw', { country: countryName(snap.feed.country) }) : t('followLawOff')}</p>
            </div>
            <Toggle
              on={!!snap?.feed}
              disabled={!!snap?.feed}
              label={t('followLaw')}
              onClick={() =>
                run(t('turningOn'), async () => {
                  await followLaw(chain, wallet, vault, vault.answers.packId.toUpperCase());
                  await refresh();
                })
              }
            />
          </div>
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="grow">
              <p style={{ fontWeight: 500 }}>{t('yieldTitle')}</p>
              <p className="small muted">{t('yieldSoon')}</p>
            </div>
            <Toggle on={false} disabled label={t('yieldTitle')} onClick={() => {}} />
          </div>
        </div>
        <h2 className="tiny muted">{t('account')}</h2>
        <div className="card" style={{ gap: 6 }}>
          <div className="small">
            Wallet ({wallet.label}): <span className="mono">{wallet.address}</span>
          </div>
          <div className="small">
            {t('vault')}: <span className="mono">{vault.vault}</span>
          </div>
          <div className="small">
            {t('payAddress')}: <span className="mono">{vault.inbox}</span>
          </div>
          <button
            className="link"
            onClick={async () => {
              await wallet.disconnect();
              setVault(null);
              setWallet(null);
            }}
          >
            {t('signOut')}
          </button>
        </div>
      </div>
      <Tabs current="settings" />
    </>
  );
}

const KNOWN_EVENTS = ['received', 'tax_paid', 'released', 'converted', 'invested', 'harvested'];
const eventText = (kind: string) => t((KNOWN_EVENTS.includes(kind) ? `ev_${kind}` : 'ev_change') as Key);

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function Activity() {
  const { snap, chain } = useApp();
  const ev = snap?.events ?? [];
  const cfg = chain.cfg;
  const symbol = (token: string) =>
    token === cfg.tokens.usd.contract ? cfg.tokens.usd.code : token === cfg.tokens.eur.contract ? cfg.tokens.eur.code : token === cfg.cctp?.usdc.contract ? 'USDC' : token.slice(0, 6);
  const day = new Date().toISOString().slice(0, 10);
  const exportFor = (tool: TaxTool | 'generic') =>
    download(`kyros-${tool}-${day}.csv`, tool === 'generic' ? toCsv(ev, chain.explorerTx.bind(chain)) : taxToolCsv(tool, ev, symbol));
  return (
    <>
      <div className="content">
        <h1>{t('movements')}</h1>
        {ev.length === 0 && <p className="muted">{t('noMovements')}</p>}
        {ev.length > 0 && (
          <div className="card" data-testid="exports">
            <p style={{ fontWeight: 600 }}>{t('exportTitle')}</p>
            <p className="small muted">{t('exportSub')}</p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {TAX_TOOLS.map((x) => (
                <Button key={x.id} small kind="secondary" onClick={() => exportFor(x.id)}>
                  {x.name}
                </Button>
              ))}
              <Button small kind="secondary" onClick={() => exportFor('generic')}>
                {t('exportGeneric')}
              </Button>
            </div>
          </div>
        )}
        <div className="list">
          {ev.map((e) => (
            <a className="item" key={e.txHash + e.kind} href={chain.explorerTx(e.txHash)} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{eventText(e.kind)}</div>
                <div className="small muted">{fmtDateTime(new Date(e.closedAt))}</div>
              </div>
              <b>{e.kind === 'received' ? `+${money(e.net ?? 0n)}` : e.amount ? money(e.amount) : ''}</b>
            </a>
          ))}
        </div>
      </div>
      <Tabs current="activity" />
    </>
  );
}

export function Alerts() {
  const { snap } = useApp();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const items: { tone: string; title: string; body: string }[] = [];
  if (snap?.pendingConversionAt && snap.pendingConversionAt > now)
    items.push({ tone: 'info', title: t('al_scheduled'), body: t('al_scheduledBody', { date: fmtDateTime(new Date(Number(snap.pendingConversionAt) * 1000)) }) });
  if (snap?.feed) items.push({ tone: 'ok', title: t('al_law'), body: t('al_lawBody', { country: countryName(snap.feed.country) }) });
  if (snap?.conversion && (snap.reserved.usd ?? 0n) > 0n) items.push({ tone: 'warn', title: t('al_usd'), body: t('al_usdBody') });
  for (const d of snap?.deadlines ?? []) {
    const days = Math.ceil((new Date(`${d.date}T23:59:59Z`).getTime() - Date.now()) / 86_400_000);
    if (days > 30) break;
    items.push({ tone: days <= 7 ? 'warn' : 'info', title: t('al_deadline', { days }), body: t('al_deadlineBody', { what: deadlineText(d), date: fmtDay(new Date(`${d.date}T12:00:00Z`)) }) });
  }
  const paid = snap?.events.filter((e) => e.kind === 'tax_paid') ?? [];
  if (paid.length) items.push({ tone: 'ok', title: t('al_paid'), body: t('al_paidBody', { n: paid.length }) });
  return (
    <>
      <div className="content">
        <h1>{t('alerts')}</h1>
        {items.length === 0 && <p className="muted">{t('nothingPending')}</p>}
        {items.map((i) => (
          <div key={i.title + i.body} className={`card ${i.tone}`}>
            <p className="tiny" style={{ fontWeight: 700 }}>
              {i.title}
            </p>
            <p className="small">{i.body}</p>
          </div>
        ))}
      </div>
      <Tabs current="alerts" />
    </>
  );
}

export const _unused = UNIT;
