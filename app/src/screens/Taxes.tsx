/**
 * The parts of the tax screen that deal with dates and instalments: the next
 * deadlines (moved for weekends and holidays the country's way), what to pay
 * on each prepayment, the tax office's letter, and scheduled payments.
 */
import { useState } from 'react';
import { daysFromCivil, dayString, drawFrom, incomeTaxBuckets, readNotice, suggestPrepayment, taxYearStart, type Deadline, type PeriodKind, type ScheduledItem } from 'kyros-sdk';
import { applyNotice, cancelScheduled, loadInputs, money, noticeText, runDueScheduled, saveInputs, schedulePayment, taxYearPeriods, type Held, type Snapshot, type VaultInfo } from '../kyros';
import { fmtDate as fmtDay, t } from '../i18n';
import { Button, TxLink, useApp } from '../ui';

const DAY = 86_400n;
const endOfDay = (iso: string) => (daysFromCivil(BigInt(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))) + 1n) * DAY;
const showDay = (iso: string) => fmtDay(new Date(`${iso}T12:00:00Z`));
const toUnits = (raw: string): bigint | undefined => {
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
  return raw.trim() && Number.isFinite(n) && n >= 0 ? BigInt(Math.round(n * 1e7)) : undefined;
};
const fromUnits = (x: bigint | undefined) => (x === undefined ? '' : (Number(x) / 1e7).toFixed(2));

export function deadlineLabel(d: Deadline): string {
  if (d.kind === 'prepayment') return d.what;
  if (d.kind === 'vat') return t('dlVat');
  if (d.amount?.kind === 'notice') return d.what;
  return t('dlIncome', { what: d.what });
}

/** When to schedule a payment due by `payBy` (end of day): two days before, at 08:00 UTC, and never in the past. */
export function scheduleAt(payBy: bigint): bigint {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const at = payBy - 3n * DAY + 8n * 3_600n;
  return at > now + 60n ? at : now + 60n;
}

/** Income-tax reserve rows of the vault (what instalments are paid from). */
function incomeRows(s: Snapshot, v: VaultInfo): Held[] {
  const names = s.pack ? incomeTaxBuckets(s.pack, v.presetId) : [];
  return s.held.filter((h) => h.bucket !== 'vat' && (names.length === 0 || names.includes(h.bucket)));
}

export function WorkdaysNote() {
  const { snap } = useApp();
  const w = snap?.pack?.calendar.workdays;
  if (!w) return null;
  return (
    <p className="tiny muted" data-testid="workdays-note">
      {w.rule === 'next' ? t('wdNext') : t('wdPrev')} {w.verified ? '' : t('wdUnverified')}
    </p>
  );
}

export function Deadlines() {
  const { snap } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const soon = (snap?.deadlines ?? []).filter((d) => new Date(`${d.date}T00:00:00Z`).getTime() - Date.now() < 120 * 86_400_000).slice(0, 6);
  if (!soon.length) return null;
  return (
    <div className="card" data-testid="deadlines">
      <p style={{ fontWeight: 600 }}>{t('nextDeadlines')}</p>
      {soon.map((d) => {
        const k = `${d.legal}${d.kind}${d.bucket ?? ''}${d.what}`;
        return (
          <div key={k} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="row spread small">
              <span>{deadlineLabel(d)}</span>
              <b>{showDay(d.date)}</b>
            </div>
            {d.legal !== d.date && <span className="tiny muted">{t('legalDate', { date: showDay(d.legal) })}</span>}
            {d.kind === 'prepayment' &&
              (open === k ? (
                <Instalment d={d} />
              ) : (
                <Button small kind="secondary" testid="calc-instalment" onClick={() => setOpen(k)}>
                  {t('calcPay')}
                </Button>
              ))}
          </div>
        );
      })}
      <WorkdaysNote />
    </div>
  );
}

function Instalment({ d }: { d: Deadline }) {
  const { snap, vault, chain, wallet, run, refresh } = useApp();
  const [inputs, setInputs] = useState(() => (vault ? loadInputs(vault.vault) : { expenses: {}, previousYearTax: {}, notice: {} }));
  const [amount, setAmount] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  if (!snap?.pack || !vault || !wallet || !snap.periodKind) return null;
  const pack = snap.pack;
  const kind = snap.periodKind as PeriodKind;
  const legal = endOfDay(d.legal);
  const rule = d.amount ?? { kind: 'reservedSoFar' as const };
  const yearKey = dayString(taxYearStart(pack.calendar.fiscalYearStart, legal, 'taxYear' in rule ? (rule.taxYear ?? 0) : 0) + DAY);
  const prevKey = dayString(taxYearStart(pack.calendar.fiscalYearStart, legal, -1) + DAY);
  const s = suggestPrepayment(rule, pack, kind, legal, snap.figures, {
    expenses: toUnits(inputs.expenses[yearKey] ?? ''),
    previousYearTax: toUnits(inputs.previousYearTax[prevKey] ?? ''),
    notice: toUnits(inputs.notice[d.legal] ?? ''),
  });
  const save = (field: 'expenses' | 'previousYearTax' | 'notice', k: string, v: string) => {
    const next = { ...inputs, [field]: { ...inputs[field], [k]: v.replace(/[^\d.,]/g, '') } };
    setInputs(next);
    saveInputs(vault.vault, next);
  };
  const chosen = amount !== null ? toUnits(amount) : (s.amount ?? undefined);
  const { items, short } = drawFrom(incomeRows(snap, vault), chosen ?? 0n);
  const payBy = endOfDay(d.date);
  const share = 'share' in rule ? Math.round(rule.share * 100) : 0;
  const basis =
    s.rule === 'es130'
      ? t('inst_es130', { income: money(s.income ?? 0n), expenses: money(toUnits(inputs.expenses[yearKey] ?? '') ?? 0n), withheld: money(s.withheld ?? 0n), paid: money(s.paid ?? 0n) })
      : s.rule === 'annualized'
        ? t('inst_annualized', { share, estimate: money(s.estimate ?? 0n), paid: money(s.paid ?? 0n) })
        : s.rule === 'previousYear'
          ? t('inst_previousYear', { share })
          : s.rule === 'notice'
            ? t('inst_notice')
            : t('inst_reservedSoFar');
  const send = (at: bigint | null) =>
    run(at === null ? t('paying') : t('scheduling'), async () => {
      const list: ScheduledItem[] = items;
      if (!list.length) throw new Error(t('badAmount', { max: money(incomeRows(snap, vault).reduce((a, h) => a + h.amount, 0n)) }));
      // One signature: the payment is scheduled, and when it is for now the app runs it straight away.
      const h = await schedulePayment(chain, wallet, vault, at ?? BigInt(Math.floor(Date.now() / 1000)), list);
      if (at === null) {
        await refresh();
        const fresh = { ...snap, scheduled: await chain.client.scheduledPayments(vault.vault) };
        await runDueScheduled(chain, fresh, vault);
      }
      setHash(h);
      await refresh();
    });
  return (
    <div className="item" data-testid="instalment" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      {s.needs === 'expenses' || s.rule === 'es130' ? (
        <label className="tiny">
          {t('needExpenses')}
          <input className="input" inputMode="decimal" value={inputs.expenses[yearKey] ?? ''} onChange={(e) => save('expenses', yearKey, e.target.value)} />
        </label>
      ) : null}
      {s.rule === 'previousYear' && (
        <label className="tiny">
          {t('needPrevYear')}
          <input className="input" inputMode="decimal" value={inputs.previousYearTax[prevKey] ?? ''} onChange={(e) => save('previousYearTax', prevKey, e.target.value)} />
        </label>
      )}
      {s.rule === 'notice' && (
        <label className="tiny">
          {t('needNotice')}
          <input className="input" inputMode="decimal" value={inputs.notice[d.legal] ?? ''} onChange={(e) => save('notice', d.legal, e.target.value)} />
        </label>
      )}
      <div className="row spread small">
        <span>{t('instSuggested')}</span>
        <b data-testid="instalment-amount">{s.amount === null ? '…' : money(s.amount)}</b>
      </div>
      <span className="tiny muted">{basis}</span>
      {s.needs === 'expenses' && <span className="tiny muted">{t('upperBound')}</span>}
      {s.mayBeExempt && <span className="tiny">{t('instExempt')}</span>}
      <input className="input" inputMode="decimal" aria-label={t('amount')} placeholder={fromUnits(s.amount ?? undefined)} value={amount ?? ''} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} />
      {short > 0n && <span className="tiny">{t('short', { amount: money(short) })}</span>}
      <div className="row">
        <Button small disabled={!chosen} onClick={() => send(null)}>
          {t('payNow')}
        </Button>
        <Button small kind="secondary" disabled={!chosen} onClick={() => send(scheduleAt(payBy))}>
          {t('scheduleOn', { date: fmtDay(new Date(Number(scheduleAt(payBy)) * 1000)) })}
        </Button>
      </div>
      {hash && <TxLink hash={hash} />}
    </div>
  );
}

export function NoticeReader() {
  const { snap, vault, chain, wallet, run, refresh } = useApp();
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [read, setRead] = useState<null | boolean>(null);
  const [purpose, setPurpose] = useState<'year' | 'next'>('year');
  const [done, setDone] = useState<string | null>(null);
  const [hashes, setHashes] = useState<string[]>([]);
  const [picked, setYear] = useState('');
  if (!snap?.pack || !vault || !wallet || !snap.periodKind) return null;
  const pack = snap.pack;
  const kind = snap.periodKind as PeriodKind;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const years = [-1, 0, -2].map((o) => taxYearStart(pack.calendar.fiscalYearStart, now, o));
  const year = picked || String(years[0]);
  const yearLabel = (start: bigint) => {
    const a = dayString(start + DAY);
    return pack.calendar.fiscalYearStart && pack.calendar.fiscalYearStart !== '01-01' ? `${a.slice(0, 4)}/${Number(a.slice(2, 4)) + 1}` : a.slice(0, 4);
  };
  const nextPrepayment = snap.deadlines.find((d) => d.kind === 'prepayment');
  const parse = (raw: string) => {
    const r = readNotice(raw);
    setDate(r.date ?? '');
    setAmount(r.amount !== undefined ? r.amount.toFixed(2) : '');
    setRead(!!r.date);
  };
  return (
    <div className="card" data-testid="notice">
      <p style={{ fontWeight: 600 }}>{t('noticeTitle')}</p>
      <p className="tiny muted">{t('noticeSub')}</p>
      <input
        type="file"
        accept="application/pdf,.pdf,.txt,.eml,text/plain"
        data-testid="notice-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            void run(t('readingNotice'), async () => {
              const raw = await noticeText(f);
              setText(raw.slice(0, 20_000));
              parse(raw);
            });
        }}
      />
      <textarea className="input" rows={3} placeholder={t('noticePaste')} value={text} data-testid="notice-text" onChange={(e) => setText(e.target.value)} />
      <Button small kind="secondary" testid="notice-read" disabled={!text.trim()} onClick={() => parse(text)}>
        {t('noticeRead')}
      </Button>
      {read !== null && (
        <>
          <p className="tiny">{read ? t('noticeFound') : t('noticeNothing')}</p>
          <label className="tiny">
            {t('noticeDate')}
            <input className="input" type="date" data-testid="notice-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="tiny">
            {t('noticeAmount')}
            <input className="input" inputMode="decimal" data-testid="notice-amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} />
          </label>
          <label className="tiny">
            {t('noticeFor')}
            <select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value as 'year' | 'next')}>
              <option value="year">{t('noticeForYear')}</option>
              {nextPrepayment && <option value="next">{t('noticeForNext')}</option>}
            </select>
          </label>
          {purpose === 'year' ? (
            <>
              <label className="tiny">
                {t('noticeYear')}
                <select className="input" data-testid="notice-year" value={year} onChange={(e) => setYear(e.target.value)}>
                  {years.map((y) => (
                    <option key={String(y)} value={String(y)}>
                      {yearLabel(y)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="tiny muted">{t('noticeRule')}</p>
              <div className="row">
                <Button
                  small
                  testid="notice-apply"
                  disabled={!/^\d{4}-\d{2}-\d{2}$/.test(date)}
                  onClick={() =>
                    run(t('noticeApply'), async (step) => {
                      const hs = await applyNotice(chain, wallet, vault, kind, pack, { date, amount: toUnits(amount), taxYearStart: BigInt(year) }, step);
                      const due = toUnits(amount);
                      if (due && due > 0n) {
                        // The payment goes out by itself shortly before the notice's date.
                        const { from, to } = taxYearPeriods(kind, pack, BigInt(year));
                        const rows = incomeRows(snap, vault).filter((h) => h.period >= from && h.period <= to);
                        const { items } = drawFrom(rows, due);
                        if (items.length) hs.push(await schedulePayment(chain, wallet, vault, scheduleAt(endOfDay(date)), items));
                      }
                      setHashes(hs);
                      setDone(t('noticeApplied'));
                      await refresh();
                    })
                  }
                >
                  {t('noticeApply')}
                </Button>
              </div>
            </>
          ) : (
            nextPrepayment && (
              <Button
                small
                onClick={() => {
                  const inputs = loadInputs(vault.vault);
                  inputs.notice[nextPrepayment.legal] = amount;
                  saveInputs(vault.vault, inputs);
                  setDone(t('noticeUsed', { date: showDay(nextPrepayment.date) }));
                }}
              >
                {t('noticeApply')}
              </Button>
            )
          )}
          {done && (
            <p className="small" data-testid="notice-done">
              {done}
            </p>
          )}
          {hashes.map((h) => (
            <TxLink key={h} hash={h} />
          ))}
        </>
      )}
    </div>
  );
}

export function ScheduledList() {
  const { snap, vault, chain, wallet, run, refresh } = useApp();
  if (!snap?.scheduled.length || !vault || !wallet) return null;
  return (
    <div className="card" data-testid="scheduled">
      <p style={{ fontWeight: 600 }}>{t('scheduledTitle')}</p>
      {snap.scheduled.map((p) => (
        <div className="row spread small" key={p.id}>
          <span>{t('scheduledRow', { amount: money(p.payments.reduce((a, x) => a + x.amount, 0n)), date: fmtDay(new Date(Number(p.at) * 1000)) })}</span>
          <Button
            small
            kind="secondary"
            onClick={() =>
              run(t('cancelPayment'), async () => {
                await cancelScheduled(chain, wallet, vault, p.id);
                await refresh();
              })
            }
          >
            {t('cancelPayment')}
          </Button>
        </div>
      ))}
      <p className="tiny muted">{t('scheduledNote')}</p>
    </div>
  );
}
