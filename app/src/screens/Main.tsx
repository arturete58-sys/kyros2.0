import { useState } from 'react';
import { formatAmount, payableUnits, requestTotals, money as cents, type PaymentRequest } from 'kyros-sdk';
import { convertNow, expectPayment, followLaw, money, payTaxes, proposeEuroReserve, simulateClientPayment } from '../kyros';
import { countryName } from '../packs';
import { Button, pct, Tabs, Toggle, Top, TxLink, useApp } from '../ui';
import { ACTIVITY_ES, CLIENT_ES } from './Start';

const UNIT = 10_000_000n;
const bucketLabel = (b: string) => (b === 'vat' ? 'IVA' : 'Reserva de renta');

function fmtDate(secs: bigint): string {
  return new Date(Number(secs) * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
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
        <div className="row spread">
          <div>
            <h1 style={{ fontSize: 22 }}>Hola</h1>
            <p className="small muted">
              {countryName(vault.answers.packId.toUpperCase())} · {ACTIVITY_ES[vault.answers.activity][0]} · {wallet.label}
            </p>
          </div>
        </div>
        <div className="card hero" data-testid="spendable">
          <span className="label small">Puedes gastar</span>
          <span className="big">{money(s?.spendable.usd ?? 0n)} USDC</span>
          {(s?.spendable.eur ?? 0n) > 0n && <span className="small">y {money(s!.spendable.eur)} EURC</span>}
          <span className="note small">Esto es tuyo. Los impuestos ya están apartados.</span>
        </div>
        <div className="card" data-testid="reserved">
          <div className="row spread">
            <span className="small muted">Apartado para impuestos{reservedEur > 0n ? ' · en euros' : ''}</span>
            <span className="badge ok">Va bien</span>
          </div>
          <span className="amount">
            {reservedEur > 0n ? `${money(reservedEur)} €` : ''}
            {reservedEur > 0n && reservedUsd > 0n ? ' + ' : ''}
            {reservedUsd > 0n || reservedEur === 0n ? `${money(reservedUsd)} USDC` : ''}
          </span>
          <div className="row small muted">
            <span className="dot" style={{ background: 'var(--tax)' }} /> IVA {money((vat?.usd ?? 0n) + (vat?.eur ?? 0n))}
            <span className="dot" style={{ background: 'var(--warn)', marginLeft: 12 }} /> Renta {money(otherUsd + otherEur)}
          </div>
          <span className="tiny muted">Periodo actual hasta el {s?.dueDate ? fmtDate(s.dueDate) : '…'} (fecha en la que se puede liberar lo que sobre).</span>
        </div>
        <div className="card warn">
          <div className="row">
            <div className="grow">
              <p className="small" style={{ fontWeight: 600, color: 'var(--warn)' }}>
                Pagar impuestos
              </p>
              <p className="small">Cuando toque, se paga desde la bóveda con un toque.</p>
            </div>
            <Button small onClick={() => go('pay')}>
              Pagar
            </Button>
          </div>
        </div>
        <div className="card">
          <p className="small" style={{ fontWeight: 600 }}>
            Prueba un cobro <span className="badge warn">Testnet</span>
          </p>
          <p className="small muted">Un cliente de pruebas te paga 1.210 USDC de test. Verás cómo se reparte al instante.</p>
          <Button
            kind="secondary"
            testid="simulate-payment"
            onClick={() =>
              run('Tu cliente de pruebas te está pagando', async (step) => {
                step('Preparando el cliente y su dinero de prueba');
                const h = await simulateClientPayment(chain, vault.vault, 1210n * UNIT);
                setLastTx(h);
                step('Leyendo tu bóveda');
                await refresh();
              })
            }
          >
            Simular un cobro de 1.210 USDC
          </Button>
          {lastTx && <TxLink hash={lastTx} />}
        </div>
        {received.length > 0 && (
          <div className="list">
            <h2>Últimos cobros</h2>
            {received.map((e) => (
              <div className="item" key={e.txHash}>
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>Cobro de {formatAmount(e.gross ?? 0n)}</div>
                  <div className="small muted">{new Date(e.closedAt).toLocaleString('es-ES')}</div>
                </div>
                <b>+{money(e.net ?? 0n)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="fab" data-testid="request" onClick={() => go('request')}>
        + Pedir un cobro
      </button>
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
    lines: [{ description: `Factura ${number} a ${client}`, quantity: '1', unitPrice: base || '0', vatRate: String(vatBps / 100) }],
  };
  let t: ReturnType<typeof requestTotals> | null = null;
  try {
    t = requestTotals(req);
  } catch {
    t = null;
  }
  const reserveBps = vault.rule.buckets.reduce((a, b) => a + b.bps, 0);
  const bucket = vault.rule.buckets[0]?.name ?? 'income_tax';
  return (
    <>
      <div className="content">
        <Top onBack={() => go('home')} />
        <h1>Pedir un cobro</h1>
        {!done ? (
          <>
            <div className="field">
              <label>Cliente</label>
              <input className="input" value={client} onChange={(e) => setClient(e.target.value)} />
            </div>
            <div className="field">
              <label>Nº de tu factura</label>
              <input className="input" value={number} onChange={(e) => setNumber(e.target.value)} />
            </div>
            <div className="field">
              <label>Importe sin IVA (€)</label>
              <input className="input" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
            </div>
            {t && (
              <div className="card">
                <div className="row spread small">
                  <span className="muted">Base</span>
                  <b>{cents(t.net)} €</b>
                </div>
                <div className="row spread small">
                  <span className="muted">
                    IVA {pct(vatBps)} <span className="badge ok">Automático</span>
                  </span>
                  <b>{cents(t.tax)} €</b>
                </div>
                <div className="row spread small">
                  <span className="muted">Retención IRPF 15 %</span>
                  <Toggle on={withhold} onClick={() => setWithhold(!withhold)} label="Retención IRPF" />
                </div>
                {withhold && (
                  <div className="row spread small">
                    <span className="muted">Te retienen</span>
                    <b>−{cents(t.withheld)} €</b>
                  </div>
                )}
                <div className="row spread">
                  <b>Te pagarán</b>
                  <span className="amount" style={{ fontSize: 20 }}>
                    {cents(t.payable)} €
                  </span>
                </div>
              </div>
            )}
            <div className="card info">
              <p className="small">Haz la factura con tu programa de siempre. Cuando te paguen con este enlace, Kyros aparta exactamente el IVA de ese cobro.</p>
            </div>
          </>
        ) : (
          <>
            <div className="card ok">
              <p style={{ fontWeight: 600 }}>Cobro registrado en tu bóveda</p>
              <p className="small">Cuando llegue un pago con la referencia de la factura {number}, se repartirá con su IVA{withhold ? ' y su retención' : ''}.</p>
              <TxLink hash={done.hash} />
            </div>
            <div className="field">
              <label>Enlace de pago para tu cliente</label>
              <input className="input mono" readOnly value={`${location.origin}${import.meta.env.BASE_URL}#pagar?v=${vault.vault}&r=${done.ref}&a=${done.payable}`} onFocus={(e) => e.currentTarget.select()} />
            </div>
          </>
        )}
      </div>
      <div className="footer">
        {!done ? (
          <Button
            testid="register-request"
            disabled={!t || t.net <= 0n}
            onClick={() =>
              run('Registrando el cobro (confirma con tu wallet)', async (step) => {
                step('Confirma con Face ID o con tu wallet');
                const r = await expectPayment(chain, wallet, vault.vault, req, reserveBps, bucket);
                setDone({ ref: Buffer.from(r.reference).toString('hex'), hash: r.hash, payable: payableUnits(req) });
              })
            }
          >
            Registrar y crear enlace
          </Button>
        ) : (
          <>
            <Button
              testid="simulate-request-payment"
              onClick={() =>
                run('Tu cliente de pruebas está pagando la factura', async () => {
                  await simulateClientPayment(chain, vault.vault, done.payable, Buffer.from(done.ref, 'hex'));
                  await refresh();
                  go('home');
                })
              }
            >
              Simular que el cliente paga
            </Button>
            <Button kind="secondary" onClick={() => navigator.clipboard?.writeText(`${location.origin}${import.meta.env.BASE_URL}#pagar?v=${vault.vault}&r=${done.ref}&a=${done.payable}`)}>
              Copiar enlace
            </Button>
          </>
        )}
      </div>
    </>
  );
}

export function Pay() {
  const { vault, snap, chain, wallet, run, go, refresh } = useApp();
  const [hashes, setHashes] = useState<string[]>([]);
  if (!vault || !wallet) return null;
  const rows = Object.entries(snap?.buckets ?? {}).filter(([, v]) => v.usd > 0n || v.eur > 0n);
  const total = rows.reduce((a, [, v]) => a + v.usd + v.eur, 0n);
  return (
    <>
      <div className="content">
        <Top onBack={() => go('home')} />
        <h1>Pagar impuestos</h1>
        <p className="muted">Lo apartado en este periodo, listo para pagar.</p>
        <div className="card">
          {rows.length === 0 && <p className="small muted">No hay nada apartado en este periodo todavía.</p>}
          {rows.map(([b, v]) => (
            <div className="row spread" key={b}>
              <span>{bucketLabel(b)}</span>
              <b>
                {v.eur > 0n ? `${money(v.eur)} €` : ''} {v.usd > 0n ? `${money(v.usd)} USDC` : ''}
              </b>
            </div>
          ))}
          {rows.length > 0 && (
            <div className="row spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <b>Total</b>
              <span className="amount" style={{ fontSize: 20 }}>
                {money(total)}
              </span>
            </div>
          )}
        </div>
        <h2>Cómo se paga</h2>
        <div className="list">
          <div className="item small">1 · Kyros envía lo apartado a tu destino fiscal: tu anchor, el servicio que lo cambia a euros.</div>
          <div className="item small">2 · El anchor te ingresa los euros en tu cuenta bancaria.</div>
          <div className="item small">3 · Hacienda los cobra por domiciliación.</div>
        </div>
        <div className="card warn">
          <p className="small">En testnet el destino es una cuenta de pruebas que hace de anchor; no se mueve dinero real.</p>
        </div>
        {hashes.map((h) => (
          <TxLink key={h} hash={h} />
        ))}
      </div>
      <div className="footer">
        <Button
          testid="pay-taxes"
          disabled={rows.length === 0 || !snap}
          onClick={() =>
            run('Pagando tus impuestos', async (step) => {
              const hs = await payTaxes(chain, wallet, vault, snap!.period, step);
              setHashes(hs);
              await refresh();
            })
          }
        >
          Pagar desde mi bóveda
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
        <h1>Ajustes</h1>
        <h2 className="tiny muted">TU SITUACIÓN</h2>
        <div className="card" style={{ gap: 6 }}>
          <div className="row spread small">
            <span>País</span>
            <span className="muted">{countryName(vault.answers.packId.toUpperCase())}</span>
          </div>
          <div className="row spread small">
            <span>Actividad</span>
            <span className="muted">{ACTIVITY_ES[vault.answers.activity][0]}</span>
          </div>
          <div className="row spread small">
            <span>Clientes</span>
            <span className="muted">{CLIENT_ES[vault.answers.client][0]}</span>
          </div>
          <div className="row spread small">
            <span>Reparto</span>
            <span className="muted">
              IVA {pct(vault.rule.vatBps)} · renta {pct(reserveBps)}
            </span>
          </div>
        </div>
        <h2 className="tiny muted">EUROS Y LEY</h2>
        <div className="card">
          <div className="row">
            <div className="grow">
              <p style={{ fontWeight: 500 }}>Guardar mis impuestos en euros</p>
              <p className="small muted">
                {euroActive
                  ? 'Activado: lo apartado en USDC se cambia a EURC, nunca por debajo del precio de mercado menos un 1 %.'
                  : euroPending
                    ? `Se activa el ${new Date(Number(euroPending) * 1000).toLocaleTimeString('es-ES')} (plazo de aviso de seguridad).`
                    : 'Te pagan en dólares, pero Hacienda cobra en euros.'}
              </p>
            </div>
            <Toggle
              on={euroActive || !!euroPending}
              disabled={euroActive || !!euroPending || !chain.cfg.conversion}
              label="Guardar en euros"
              onClick={() =>
                run('Activando la reserva en euros (confirma con tu wallet)', async () => {
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
                run('Cambiando la reserva a euros', async () => {
                  await convertNow(chain, vault, snap!.period);
                  await refresh();
                })
              }
            >
              Cambiar ahora {money(snap!.reserved.usd)} USDC a EURC
            </Button>
          )}
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="grow">
              <p style={{ fontWeight: 500 }}>Ajustar solo si cambia la ley</p>
              <p className="small muted">{snap?.feed ? `Sigue el IVA oficial de ${snap.feed.country}.` : 'El IVA se actualiza en la fecha oficial, sin firmar nada.'}</p>
            </div>
            <Toggle
              on={!!snap?.feed}
              disabled={!!snap?.feed}
              label="Ajustar si cambia la ley"
              onClick={() =>
                run('Activando (confirma con tu wallet)', async () => {
                  await followLaw(chain, wallet, vault, vault.answers.packId.toUpperCase());
                  await refresh();
                })
              }
            />
          </div>
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <div className="grow">
              <p style={{ fontWeight: 500 }}>Hacer que rinda</p>
              <p className="small muted">Prestar una parte en Blend. Aún no disponible en testnet.</p>
            </div>
            <Toggle on={false} disabled label="Rendimiento" onClick={() => {}} />
          </div>
        </div>
        <h2 className="tiny muted">CUENTA</h2>
        <div className="card" style={{ gap: 6 }}>
          <div className="small">
            Wallet ({wallet.label}): <span className="mono">{wallet.address}</span>
          </div>
          <div className="small">
            Bóveda: <span className="mono">{vault.vault}</span>
          </div>
          <div className="small">
            Dirección de cobro: <span className="mono">{vault.inbox}</span>
          </div>
          <button
            className="link"
            onClick={async () => {
              await wallet.disconnect();
              setVault(null);
              setWallet(null);
            }}
          >
            Salir
          </button>
        </div>
      </div>
      <Tabs current="settings" />
    </>
  );
}

const KIND_ES: Record<string, string> = {
  received: 'Cobro repartido',
  tax_paid: 'Impuesto pagado',
  released: 'Reserva liberada',
  converted: 'Reserva cambiada a euros',
  rule_proposed: 'Cambio de reparto propuesto',
  destination_proposed: 'Cambio de destino propuesto',
  rule_applied: 'Cambio de reparto aplicado',
  destination_applied: 'Cambio de destino aplicado',
  change_cancelled: 'Cambio cancelado',
  invested: 'Reserva invertida',
  harvested: 'Rendimiento retirado',
};

export function Activity() {
  const { snap, chain } = useApp();
  const ev = snap?.events ?? [];
  return (
    <>
      <div className="content">
        <h1>Movimientos</h1>
        {ev.length === 0 && <p className="muted">Todavía no hay movimientos.</p>}
        <div className="list">
          {ev.map((e) => (
            <a className="item" key={e.txHash + e.kind} href={chain.explorerTx(e.txHash)} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{KIND_ES[e.kind] ?? e.kind}</div>
                <div className="small muted">{new Date(e.closedAt).toLocaleString('es-ES')}</div>
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
    items.push({ tone: 'info', title: 'CAMBIO PROGRAMADO', body: `La reserva en euros se activa el ${new Date(Number(snap.pendingConversionAt) * 1000).toLocaleString('es-ES')}. El plazo de aviso protege tu bóveda si alguien te roba el acceso.` });
  if (snap?.feed) items.push({ tone: 'ok', title: 'LEY AL DÍA', body: `Tu IVA sigue el registro oficial de ${snap.feed.country}: si cambia, tu reparto se ajusta solo en la fecha legal.` });
  if (snap?.conversion && (snap.reserved.usd ?? 0n) > 0n) items.push({ tone: 'warn', title: 'RESERVA EN DÓLARES', body: 'Tienes reserva en USDC pendiente de cambiar a euros. Puedes hacerlo en Ajustes.' });
  const paid = snap?.events.filter((e) => e.kind === 'tax_paid') ?? [];
  if (paid.length) items.push({ tone: 'ok', title: 'PAGADO', body: `${paid.length} pago(s) de impuestos hechos desde tu bóveda.` });
  return (
    <>
      <div className="content">
        <h1>Avisos</h1>
        {items.length === 0 && <p className="muted">Nada pendiente.</p>}
        {items.map((i) => (
          <div key={i.title} className={`card ${i.tone}`}>
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
