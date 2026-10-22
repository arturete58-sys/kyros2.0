/**
 * The assistant: a chat about the user's taxes, answered from the country's
 * rule pack and their own vault by the SDK's agents, on this device. It
 * never signs by itself: an answer that leads to an operation shows a button,
 * and the user's wallet asks them to confirm.
 */
import { useEffect, useRef, useState } from 'react';
import {
  assistantDocument,
  assistantIntro,
  assistantReply,
  incomeTaxBuckets,
  invoiceReference,
  payoutsOf,
  readTreasury,
  verifyPayoutVaults,
  type AssistantAction,
  type AssistantContext,
  type AssistantReply,
  type PeriodKind,
} from 'kyros-sdk';
import { convertNow, noticeText, type Snapshot, type VaultInfo } from '../kyros';
import { countryName } from '../packs';
import { getLang, t } from '../i18n';
import { Tabs, TxLink, useApp } from '../ui';
import { applyNoticeAndSchedule } from './Taxes';

interface Message {
  id: number;
  from: 'user' | 'assistant';
  text: string;
  actions?: AssistantAction[];
  txs?: string[];
}

// The conversation lives in memory while the app is open, never in storage: questions can be personal.
let history: Message[] = [];
let nextId = 1;

function context(snap: Snapshot | null, vault: VaultInfo, chain: ReturnType<typeof useApp>['chain']): AssistantContext {
  const lang = getLang();
  const pack = snap?.pack ?? null;
  const sumOf = (k: 'usd' | 'eur') => snap?.held.filter((h) => h.which === k) ?? [];
  // The dollar reserve of the period due first: what a conversion would swap.
  const usd = sumOf('usd');
  const first = usd[0];
  const dollarReserve = first ? { period: first.period, amount: usd.filter((h) => h.period === first.period).reduce((a, h) => a + h.amount, 0n), dueAt: first.payBy } : undefined;
  const investedSince = snap?.events.filter((e) => e.kind === 'invested').map((e) => BigInt(Math.floor(new Date(e.closedAt).getTime() / 1000))).sort((a, b) => (a < b ? -1 : 1))[0];
  return {
    lang,
    countryName: countryName(pack?.country ?? vault.answers.packId.toUpperCase()),
    pack,
    presetId: vault.presetId,
    rule: vault.rule,
    revenue: vault.answers.revenue,
    activity: vault.answers.activity,
    spendable: snap?.spendable,
    reserved: snap?.reserved,
    buckets: snap?.buckets,
    deadlines: snap?.deadlines,
    events: snap?.events,
    periodKind: (snap?.periodKind as PeriodKind | null) ?? null,
    incomeBuckets: pack ? incomeTaxBuckets(pack, vault.presetId) : undefined,
    euroTokens: [chain.cfg.tokens.eur.contract],
    dollarReserve,
    loadTreasury: dollarReserve
      ? (apyBps) =>
          readTreasury(chain.client, {
            vault: vault.vault,
            period: dollarReserve.period,
            fromToken: snap?.conversion?.fromToken ?? chain.dollarTokens[0],
            held: dollarReserve.amount,
            dueAt: dollarReserve.dueAt,
            noticeSecs: BigInt(chain.cfg.noticeSecs),
            investedSince,
            apyBps,
          })
      : undefined,
    verifyPayouts: async (c) => (await verifyPayoutVaults(chain.client, c, chain.cfg.tokens.usd.contract)).problems,
  };
}

/** Paragraphs and "- " lists, as the agents write them. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split('\n');
        const head = lines.filter((l) => !l.startsWith('- '));
        const items = lines.filter((l) => l.startsWith('- '));
        return (
          <div key={i} className="chat-block">
            {head.map((l, j) => (
              <p key={j}>{l}</p>
            ))}
            {items.length > 0 && (
              <ul>
                {items.map((l, j) => (
                  <li key={j}>{l.slice(2)}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}

export function Assistant() {
  const app = useApp();
  const { snap, vault, chain, wallet, run, go, refresh, lang } = app;
  const [messages, setMessages] = useState<Message[]>(history);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState('application/pdf,.pdf,.txt,.eml,text/plain,.csv,text/csv');
  const endRef = useRef<HTMLDivElement>(null);

  const push = (m: Omit<Message, 'id'>) => {
    history = [...history, { ...m, id: nextId++ }];
    setMessages(history);
  };
  const answer = (r: AssistantReply) => push({ from: 'assistant', text: r.text, actions: r.actions });

  useEffect(() => {
    if (vault && history.length === 0) answer(assistantIntro(context(snap, vault, chain)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, lang]);
  useEffect(() => {
    // The newest message in view above the composer: the chat scrolls inside the phone frame on wide screens, the page on phones.
    const box = endRef.current?.closest('.content');
    if (box && box.scrollHeight > box.clientHeight + 1) box.scrollTop = box.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
  }, [messages.length, thinking]);

  if (!vault) return null;

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || thinking) return;
    setText('');
    push({ from: 'user', text: question });
    setThinking(true);
    try {
      answer(await assistantReply(question, context(snap, vault, chain)));
    } finally {
      setThinking(false);
    }
  };

  const attach = async (f: File) => {
    push({ from: 'user', text: `📎 ${f.name}` });
    setThinking(true);
    try {
      const raw = f.name.toLowerCase().endsWith('.csv') || /csv/.test(f.type) ? await f.text() : await noticeText(f);
      answer(await assistantDocument(raw.slice(0, 200_000), f.name, context(snap, vault, chain)));
    } catch (e) {
      push({ from: 'assistant', text: t('assistantReadError', { error: (e as Error).message.slice(0, 120) }) });
    } finally {
      setThinking(false);
    }
  };

  const done = (txs: string[]) => {
    push({ from: 'assistant', text: t('assistantDone'), txs });
    void refresh();
  };

  const act = (a: AssistantAction) => {
    if (a.kind === 'ask') return void ask(a.text);
    if (a.kind === 'go') return go(a.screen);
    if (a.kind === 'attach') {
      setAccept(a.accept === 'csv' ? '.csv,text/csv' : 'application/pdf,.pdf,.txt,.eml,text/plain,.csv,text/csv');
      // Let the accept attribute update before the picker opens.
      return void setTimeout(() => fileRef.current?.click(), 0);
    }
    if (!wallet) return;
    if (a.kind === 'apply-notice') {
      if (!snap?.pack || !snap.periodKind) return;
      const pack = snap.pack;
      const kind = snap.periodKind as PeriodKind;
      void run(t('noticeApply'), async (step) => {
        const amount = a.amount !== undefined ? BigInt(Math.round(a.amount * 100)) * 100_000n : undefined;
        done(await applyNoticeAndSchedule(chain, wallet, vault, snap, kind, pack, { date: a.date, amount, taxYearStart: a.taxYearStart }, step));
      });
    } else if (a.kind === 'register-invoice') {
      void run(a.label, async () => done([await wallet.signAndSend(chain.client.expectInvoiceOp(vault.vault, invoiceReference(a.number), a.terms))]));
    } else if (a.kind === 'pay-many') {
      void run(a.label, async (step) => {
        const hs: string[] = [];
        for (const [i, r] of a.check.runs.entries()) {
          step(t('assistantRun', { n: i + 1, of: a.check.runs.length }));
          hs.push(await wallet.signAndSend(chain.client.payManyOp(chain.cfg.router, { from: wallet.address, token: chain.cfg.tokens.usd.contract, payouts: payoutsOf(r) })));
        }
        done(hs);
      });
    } else if (a.kind === 'convert') {
      void run(a.label, async () => done([await convertNow(chain, vault, a.period)]));
    }
  };

  return (
    <>
      <div className="content chat" data-testid="assistant">
        <div className="chat-head">
          <h1>{t('assistantTitle')}</h1>
          <p className="tiny muted">{t('assistantPrivate')}</p>
        </div>
        <div className="chat-log" role="log" aria-live="polite" aria-label={t('assistantTitle')}>
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.from}`} data-testid={`msg-${m.from}`}>
              {m.from === 'user' ? <p>{m.text}</p> : <Rich text={m.text} />}
              {m.txs?.map((h) => (
                <TxLink key={h} hash={h} />
              ))}
              {m.actions && m.actions.length > 0 && (
                <div className="chat-actions">
                  {m.actions.map((a, i) => (
                    <button
                      key={i}
                      className={`chip${a.kind === 'ask' ? '' : a.kind === 'go' || a.kind === 'attach' ? ' go' : ' sign'}`}
                      onClick={() => act(a)}
                      disabled={thinking || ((a.kind === 'apply-notice' || a.kind === 'register-invoice' || a.kind === 'pay-many' || a.kind === 'convert') && !wallet)}
                      data-testid={`act-${a.kind}`}
                    >
                      {a.kind === 'ask' ? a.text : a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {thinking && (
            <div className="bubble assistant typing" aria-label={t('assistantThinking')}>
              <span />
              <span />
              <span />
            </div>
          )}
          <div ref={endRef} className="chat-end" />
        </div>
      </div>
      <div className="dock">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <button type="button" className="icon-btn" aria-label={t('assistantAttach')} title={t('assistantAttach')} onClick={() => fileRef.current?.click()} data-testid="assistant-attach">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m20.5 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
          </svg>
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={accept}
          data-testid="assistant-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void attach(f);
          }}
        />
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('assistantPlaceholder')} aria-label={t('assistantPlaceholder')} data-testid="assistant-input" enterKeyHint="send" />
        <button type="submit" className="icon-btn send" aria-label={t('assistantSend')} title={t('assistantSend')} disabled={!text.trim() || thinking} data-testid="assistant-send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
      <Tabs current="assistant" />
      </div>
    </>
  );
}
