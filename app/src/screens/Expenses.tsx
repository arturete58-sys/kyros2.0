/**
 * Expenses and deductions: the user's supplier invoices and receipts (kept on
 * this device), and what they change under their country's rules: the income
 * tax and contributions they save, the input VAT that comes back (or why it
 * does not), the prepayments, and the reserve the vault should keep.
 */
import { useMemo, useRef, useState } from 'react';
import {
  assistantText,
  deductionSummary,
  deductionTexts,
  expenseFromDocument,
  expensesInTaxYear,
  type AssistantTextKey,
  type DeductionSummary,
  type Expense,
  type ExpenseCategory,
  periodStart,
  type RulePack,
} from 'kyros-sdk';
import { loadExpenses, noticeText, rememberMine, saveExpenses, type Snapshot, type VaultInfo } from '../kyros';
import { countryName } from '../packs';
import { fmtDate, fmtNumber, getLang, t } from '../i18n';
import { Button, pct, Tabs, Top, TxLink, useApp } from '../ui';

const CATEGORIES: ExpenseCategory[] = ['software', 'equipment', 'office', 'travel', 'professional', 'telecom', 'training', 'marketing', 'other'];
const say = (k: string, vars?: Record<string, string | number>) => assistantText(getLang(), k as AssistantTextKey, vars);
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const num = (x: number) => fmtNumber(x, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parse = (s: string) => {
  const v = Number(s.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};

/** The year's deductions for a vault, from the expenses kept on this device. */
export function deductionsOf(v: VaultInfo, pack: RulePack, list = loadExpenses(v.vault), snap?: Snapshot | null): { summary: DeductionSummary; year: ReturnType<typeof expensesInTaxYear> } {
  const year = expensesInTaxYear(pack, list);
  // The year's income, withholding and income tax paid so far, from the vault (for Spain's modelo 130).
  const from = Date.parse(`${year.from}T00:00:00Z`) / 1000;
  const figs = snap?.periodKind ? snap.figures : [];
  const u = (x: bigint) => Number(x) / 1e7;
  const inYear = figs.filter((f) => snap?.periodKind && Number(periodStart(snap.periodKind, f.id)) >= from);
  const summary = deductionSummary(pack, v.presetId, v.rule, {
    revenue: v.answers.revenue,
    expenses: year.expenses,
    activity: v.answers.activity,
    region: v.answers.region,
    incomeYtd: inYear.length ? inYear.reduce((a, f) => a + u(f.income), 0) : undefined,
    withheldYtd: inYear.reduce((a, f) => a + u(f.withheld), 0),
    paidYtd: inYear.reduce((a, f) => a + u(f.incomePaid), 0),
  });
  return { summary, year };
}

interface Draft {
  date: string;
  supplier: string;
  base: string;
  vat: string;
  category: ExpenseCategory;
  deductible: boolean;
  ref?: string;
}

const emptyDraft = (): Draft => ({ date: new Date().toISOString().slice(0, 10), supplier: '', base: '', vat: '', category: 'software', deductible: true });

export function Expenses() {
  const { vault, snap, chain, wallet, run, go, refresh } = useApp();
  const [list, setList] = useState<Expense[]>(() => (vault ? loadExpenses(vault.vault) : []));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [read, setRead] = useState(false);
  const [hash, setHash] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const pack = snap?.pack ?? null;
  const d = useMemo(() => (vault && pack ? deductionsOf(vault, pack, list, snap) : null), [vault, pack, list, snap]);
  if (!vault || !wallet) return null;
  const lang = getLang();
  const country = countryName(pack?.country ?? vault.answers.packId.toUpperCase());
  const cur = pack?.currency ?? '';
  const m = (x: number) => `${num(x)} ${cur}`;
  const vatName = pack?.vatName ?? t('vat');
  const save = (next: Expense[]) => {
    saveExpenses(vault.vault, next);
    setList(next);
  };
  const s = d?.summary;
  const tx = s ? deductionTexts(lang, s, { countryName: country, vatName: pack?.vatName, revenue: vault.answers.revenue }) : null;
  const yearLabel = d ? (d.year.from.slice(0, 4) === d.year.to.slice(0, 4) ? d.year.from.slice(0, 4) : `${d.year.from.slice(0, 4)}-${d.year.to.slice(2, 4)}`) : '';
  const proposal = s?.reserve.proposal;
  const newBps = proposal ? proposal.buckets.reduce((a, b) => a + b.bps, 0) : 0;

  const onFile = async (f: File) => {
    const text = await noticeText(f);
    const { expense } = expenseFromDocument(text);
    setDraft({ date: expense.date, supplier: expense.supplier ?? '', base: expense.base ? String(expense.base) : '', vat: expense.inputVat ? String(expense.inputVat) : '', category: expense.category, deductible: expense.deductible, ref: expense.ref });
    setRead(true);
  };

  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('home')} />
        <h1>{say('d_title')}</h1>
        <p className="muted">{say('d_sub', { country })}</p>

        {s && tx && (
          <section className="card" data-testid="deductions">
            <div className="row spread">
              <p style={{ fontWeight: 600 }}>{say('d_year', { year: yearLabel })}</p>
              <span className="badge info">{country}</span>
            </div>
            <div className="stats">
              <div>
                <span className="tiny muted">{say('d_expenses')}</span>
                <b className="num" data-testid="ded-expenses">{m(s.expenses)}</b>
              </div>
              <div>
                <span className="tiny muted">{say('d_saving')}</span>
                <b className="num ok" data-testid="ded-saving">{s.income.saving !== undefined ? m(s.income.saving) : '—'}</b>
              </div>
              {s.vat.recoverable && (
                <div>
                  <span className="tiny muted">{say('d_inputVat', { vat: vatName })}</span>
                  <b className="num">{m(s.vat.amount)}</b>
                </div>
              )}
            </div>
            {s.income.incomeTax && s.income.incomeTax.without > 0 && (
              <p className="small">
                {say('d_incomeTax')}: <span className="muted">{say('d_withWithout', { without: m(s.income.incomeTax.without), with: m(s.income.incomeTax.with) })}</span>
              </p>
            )}
            {s.income.social && s.income.social.without > 0 && (
              <p className="small">
                {say('d_social')}: <span className="muted">{say('d_withWithout', { without: m(s.income.social.without), with: m(s.income.social.with) })}</span>
              </p>
            )}
            <p className="small">{[tx.treatment, tx.justify].filter(Boolean).join(' ')}</p>
            {tx.vat && <p className="small">{tx.vat}</p>}
            {tx.prepayment.map((p) => (
              <p className="small" key={p}>
                {p}
              </p>
            ))}
            {s.reserve.recommendedAfter !== undefined && vault.rule.buckets.length > 0 && (
              <p className="small">
                {cap(s.reserve.recommendedBefore !== undefined && s.reserve.recommendedAfter < s.reserve.recommendedBefore
                  ? say('expenseReserve', { before: pct(s.reserve.recommendedBefore), after: pct(s.reserve.recommendedAfter), current: pct(s.reserve.currentBps) })
                  : say('expenseReserveSame', { pct: pct(s.reserve.recommendedAfter), current: pct(s.reserve.currentBps) }))}
              </p>
            )}
            {proposal && (
              <Button
                small
                testid="lower-reserve"
                onClick={() =>
                  run(say('a_proposeRule', { new: pct(newBps) }), async () => {
                    setHash(rememberMine(vault, await wallet.signAndSend(chain.client.proposeRuleOp(vault.vault, proposal))));
                    await refresh();
                  })
                }
              >
                {say('a_proposeRule', { new: pct(newBps) })}
              </Button>
            )}
            {hash && <TxLink hash={hash} />}
            {tx.note && <p className="tiny muted">{tx.note}</p>}
          </section>
        )}

        <div className="row" style={{ gap: 8 }}>
          <Button small testid="expense-upload" onClick={() => file.current?.click()}>
            {t('expAddDoc')}
          </Button>
          <Button
            small
            kind="secondary"
            testid="expense-hand"
            onClick={() => {
              setDraft(emptyDraft());
              setRead(false);
            }}
          >
            {t('expAddHand')}
          </Button>
          <input
            ref={file}
            type="file"
            hidden
            data-testid="expense-file"
            accept="application/pdf,.pdf,.txt,.eml,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onFile(f);
            }}
          />
        </div>

        {draft && (
          <section className="card" data-testid="expense-form" style={{ gap: 10 }}>
            {read && <p className="small muted">{t('expRead')}</p>}
            <div className="grid2">
              <label className="field">
                <span className="tiny">{t('expDate')}</span>
                <input className="input" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
              </label>
              <label className="field">
                <span className="tiny">{t('expSupplier')}</span>
                <input className="input" value={draft.supplier} onChange={(e) => setDraft({ ...draft, supplier: e.target.value })} />
              </label>
              <label className="field">
                <span className="tiny">{t('expBase')}</span>
                <input className="input" inputMode="decimal" data-testid="expense-base" value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })} />
              </label>
              <label className="field">
                <span className="tiny">{t('expVatPaid', { vat: vatName })}</span>
                <input className="input" inputMode="decimal" data-testid="expense-vat" value={draft.vat} onChange={(e) => setDraft({ ...draft, vat: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="tiny">{t('expCategory')}</span>
              <select className="input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ExpenseCategory })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {say(`c_${c}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={draft.deductible} onChange={(e) => setDraft({ ...draft, deductible: e.target.checked })} />
              {t('expDeductible')}
            </label>
            <div className="row" style={{ gap: 8 }}>
              <Button
                small
                testid="expense-save"
                disabled={!(parse(draft.base) > 0) || !draft.date}
                onClick={() => {
                  const e: Expense = {
                    date: draft.date,
                    supplier: draft.supplier.trim() || undefined,
                    base: parse(draft.base),
                    inputVat: parse(draft.vat),
                    category: draft.category,
                    deductible: draft.deductible,
                    ref: draft.ref,
                  };
                  save([...list, e]);
                  setDraft(null);
                }}
              >
                {t('expSave')}
              </Button>
              <button className="link" onClick={() => setDraft(null)}>
                {t('back')}
              </button>
            </div>
          </section>
        )}

        <div className="list" data-testid="expense-list">
          <h2>{t('expList')}</h2>
          {d && d.year.expenses.length === 0 && <p className="small muted">{t('expNone')}</p>}
          {d &&
            [...d.year.expenses]
              .sort((a, b) => (a.date < b.date ? 1 : -1))
              .map((e) => {
                const i = list.indexOf(e);
                return (
                  <div className="item" key={`${i}-${e.date}-${e.base}`}>
                    <div className="grow">
                      <div style={{ fontWeight: 500 }}>{e.supplier ?? say(`c_${e.category}`)}</div>
                      <div className="tiny muted">
                        {fmtDate(new Date(`${e.date}T12:00:00Z`))} · {say(`c_${e.category}`)}
                        {e.deductible ? '' : ` · ${t('expNotDeductible')}`}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <b className="num">{m(e.base)}</b>
                      {e.inputVat > 0 && <div className="tiny muted">+ {m(e.inputVat)} {vatName}</div>}
                    </div>
                    <div className="col" style={{ gap: 4 }}>
                      <button className="link tiny" onClick={() => save(list.map((x, j) => (j === i ? { ...x, deductible: !x.deductible } : x)))}>
                        {e.deductible ? t('expExclude') : t('expInclude')}
                      </button>
                      <button className="link tiny" aria-label={t('expDelete')} onClick={() => save(list.filter((_, j) => j !== i))}>
                        {t('expDelete')}
                      </button>
                    </div>
                  </div>
                );
              })}
        </div>
        <p className="tiny muted">{t('expDisclaimer')}</p>
      </div>
      <Tabs current="home" />
    </>
  );
}

/** Home: the year's deductions at a glance. */
export function ExpensesCard() {
  const { vault, snap, go } = useApp();
  const pack = snap?.pack ?? null;
  const d = useMemo(() => (vault && pack && !vault.archivedOf ? deductionsOf(vault, pack, undefined, snap) : null), [vault, pack, snap]);
  if (!vault || !pack || !d) return null;
  const cur = pack.currency;
  const country = countryName(pack.country);
  return (
    <button className="card link-card" data-testid="expenses-card" onClick={() => go('expenses')}>
      <div className="row spread">
        <b>{say('d_title')}</b>
        <span aria-hidden>›</span>
      </div>
      <span className="small muted">
        {d.year.expenses.length
          ? t('expHomeSub', { amount: `${num(d.summary.expenses)} ${cur}`, saving: `${num(d.summary.income.saving ?? 0)} ${cur}` })
          : t('expHomeEmpty', { country })}
      </span>
    </button>
  );
}
