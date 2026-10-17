import { useEffect, useMemo, useState } from 'react';
import { split, type ActivityId, type ClientKind, type RulePack } from 'kyros-sdk';
import { countries, countryName, loadPack } from '../packs';
import { createVault, followLaw, makePlan, money, type Answers } from '../kyros';
import { connectPasskeyWallet, createPasskeyWallet } from '../wallet/passkey';
import { Button, Option, pct, Seg, Toggle, Top, useApp } from '../ui';

export const ACTIVITY_ES: Record<ActivityId, [string, string]> = {
  software: ['Desarrollo de software', 'Apps, webs, smart contracts'],
  consulting: ['Consultoría', 'Asesoría, gestión, marketing'],
  creative: ['Diseño y contenido', 'Diseño, vídeo, creadores'],
  web3: ['Servicios Web3', 'Auditorías, nodos, contratos'],
  ecommerce: ['Venta online', 'Productos físicos o digitales'],
  education: ['Formación', 'Cursos y clases reconocidos'],
  health: ['Salud', 'Atención médica y sanitaria'],
  books: ['Libros y e-books', 'Edición y venta de libros'],
  hospitality: ['Hostelería', 'Restaurantes y comida'],
};

export const CLIENT_ES: Record<ClientKind, [string, string]> = {
  'business-local': ['Empresas de tu país', 'Facturas con IVA'],
  'consumer-local': ['Particulares de tu país', 'Facturas con IVA'],
  'business-eu': ['Empresas de otro país de la UE', 'Sin IVA: lo declara tu cliente'],
  abroad: ['Clientes de fuera de tu país', 'Normalmente sin IVA'],
};

const PRECISION_ES: Record<string, [string, string]> = {
  exact: ['Exacto', 'ok'],
  presumptive: ['Presunto', 'info'],
  'exact-on-profit': ['Exacto sobre beneficio', 'info'],
  estimate: ['Estimación', 'warn'],
  none: ['Sin estimación', 'warn'],
};

export function vatLabel(t: string, bps: number, name = 'IVA'): string {
  switch (t) {
    case 'standard':
      return `${name} ${pct(bps)}`;
    case 'reduced':
      return `${name} reducido ${pct(bps)}`;
    case 'exempt':
      return `Exento de ${name}`;
    case 'reverse-charge':
      return `Sin ${name}: lo declara tu cliente`;
    case 'outside-scope':
      return `Sin ${name}: cliente en el extranjero`;
    default:
      return `Sin ${name}`;
  }
}

export function Welcome() {
  const { chain, setWallet, run } = useApp();
  const [name, setName] = useState('');
  const start = (f: () => Promise<import('../wallet/types').Wallet>, title: string) =>
    run(title, async (step) => {
      step('Esperando a tu Face ID o huella');
      const w = await f();
      setWallet(w);
      return w;
    });
  return (
    <>
      <div className="content" style={{ justifyContent: 'center' }}>
        <div className="logo">Kyros</div>
        <h1>Aparta tus impuestos en el momento en que cobras.</h1>
        <p className="muted">Cada cobro en stablecoins se reparte solo: lo tuyo a tu wallet, el IVA y la renta a tu bóveda, hasta que toque pagar.</p>
        <div className="card info">
          <p className="small">
            <b>Tu dinero es tuyo.</b> La bóveda es un contrato que solo tú controlas; Kyros no guarda tus claves ni tus fondos.
          </p>
        </div>
        <div className="field">
          <label htmlFor="name">Tu nombre (para tu passkey)</label>
          <input id="name" className="input" value={name} placeholder="Lucía" onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="footer">
        <Button testid="create-passkey" onClick={() => start(() => createPasskeyWallet(chain, name.trim() || 'Kyros'), 'Creando tu wallet con Face ID')}>
          Crear mi cuenta con Face ID
        </Button>
        <Button kind="secondary" testid="connect-passkey" onClick={() => start(() => connectPasskeyWallet(chain), 'Entrando con Face ID')}>
          Ya tengo cuenta
        </Button>
        <button className="link" style={{ textAlign: 'center', padding: 8 }} onClick={() => start(async () => (await import('../wallet/classic')).connectClassicWallet(chain), 'Conectando tu wallet')}>
          Conectar otra wallet (Freighter, LOBSTR, xBull…)
        </button>
        <p className="tiny muted" style={{ textAlign: 'center' }}>
          Red de pruebas de Stellar (testnet): el dinero no es real.
        </p>
      </div>
    </>
  );
}

export function Onboarding() {
  const { chain, wallet, setVault, run } = useApp();
  const all = useMemo(countries, []);
  const [step, setStep] = useState(1);
  const [packId, setPackId] = useState('es');
  const [pack, setPack] = useState<RulePack | null>(null);
  const [region, setRegion] = useState<string | undefined>('MD');
  const [resident, setResident] = useState<Answers['resident']>('yes');
  const [activity, setActivity] = useState<ActivityId>('software');
  const [client, setClient] = useState<ClientKind>('business-local');
  const [revenue, setRevenue] = useState('45000');
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    loadPack(packId).then((p) => {
      setPack(p);
      setRegion(p.regions?.length ? p.regions.find((r) => r.id === 'MD')?.id ?? p.regions[0].id : undefined);
    });
  }, [packId]);

  const answers: Answers = { packId, region, resident, activity, client, revenue: Number(revenue) || 0 };
  const plan = useMemo(() => (pack && step === 4 ? makePlan(pack, answers) : null), [pack, step, packId, region, activity, client, revenue]);

  if (step === 1)
    return (
      <>
        <div className="content">
          <Top step={1} />
          <h1>¿Dónde vives la mayor parte del año?</h1>
          <p className="muted">Pagas impuestos donde tienes tu residencia fiscal, no donde está tu cliente.</p>
          <div className="field">
            <label htmlFor="country">País</label>
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
              <label htmlFor="region">Región</label>
              <select id="region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
                {pack.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name ?? r.id}
                  </option>
                ))}
              </select>
              <span className="tiny muted">El impuesto sobre la renta cambia según la región. Lo tenemos en cuenta.</span>
            </div>
          ) : null}
          <div className="card">
            <p className="small" style={{ fontWeight: 500 }}>
              ¿Pasas más de 183 días al año aquí?
            </p>
            <Seg value={resident} onChange={setResident} options={[['yes', 'Sí'], ['no', 'No'], ['unsure', 'No lo sé']]} />
            {resident !== 'yes' && (
              <p className="tiny muted">Si vives entre varios países, tu residencia fiscal depende también de dónde está tu casa y tu familia. Si dudas, consúltalo con un asesor.</p>
            )}
          </div>
        </div>
        <div className="footer">
          <Button testid="next-1" onClick={() => setStep(2)} disabled={!pack}>
            Continuar
          </Button>
        </div>
      </>
    );

  if (step === 2)
    return (
      <>
        <div className="content">
          <Top onBack={() => setStep(1)} step={2} />
          <h1>¿A qué te dedicas?</h1>
          <p className="muted">Con esto elegimos el IVA y el régimen que te corresponden.</p>
          {(Object.keys(ACTIVITY_ES) as ActivityId[]).map((a) => (
            <Option key={a} testid={`activity-${a}`} on={activity === a} title={ACTIVITY_ES[a][0]} sub={ACTIVITY_ES[a][1]} onClick={() => setActivity(a)} />
          ))}
        </div>
        <div className="footer">
          <Button testid="next-2" onClick={() => setStep(3)}>
            Continuar
          </Button>
        </div>
      </>
    );

  if (step === 3)
    return (
      <>
        <div className="content">
          <Top onBack={() => setStep(2)} step={3} />
          <h1>¿Quién te paga normalmente?</h1>
          <p className="muted">Si tienes de todo, elige lo más habitual. Podrás cambiarlo en cada cobro.</p>
          {(Object.keys(CLIENT_ES) as ClientKind[]).map((k) => (
            <Option key={k} testid={`client-${k}`} on={client === k} title={CLIENT_ES[k][0]} sub={CLIENT_ES[k][1]} onClick={() => setClient(k)} />
          ))}
          <div className="field">
            <label htmlFor="revenue">¿Cuánto crees que facturarás este año? ({pack?.currency ?? 'EUR'})</label>
            <input id="revenue" className="input" inputMode="numeric" value={revenue} onChange={(e) => setRevenue(e.target.value.replace(/[^\d]/g, ''))} />
            <span className="tiny muted">Una cifra aproximada basta. Sirve para calcular tu reserva.</span>
          </div>
        </div>
        <div className="footer">
          <Button testid="next-3" onClick={() => setStep(4)}>
            Ver mi plan
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
  const [precLabel, precTone] = PRECISION_ES[s.precision] ?? ['Estimación', 'warn'];
  const canFollow = s.vat.treatment === 'standard';
  return (
    <>
      <div className="content">
        <Top onBack={() => setStep(3)} />
        <h1>Tu plan está listo</h1>
        <p className="muted">Así repartiremos cada cobro, sin que tengas que hacer nada.</p>
        <div className="card">
          <p className="small muted">Si te pagan {money(gross)} USDC</p>
          <div className="bar">
            <span style={{ width: w(ex.net), background: 'var(--spend)' }} />
            {ex.vat > 0n && <span style={{ width: w(ex.vat), background: 'var(--tax)' }} />}
            {reserveOnly > 0n && <span style={{ width: w(reserveOnly), background: 'var(--warn)' }} />}
          </div>
          <div className="row">
            <span className="dot" style={{ background: 'var(--spend)' }} />
            <span className="grow">Para ti</span>
            <b>{money(ex.net)}</b>
          </div>
          <div className="row">
            <span className="dot" style={{ background: 'var(--tax)' }} />
            <span className="grow">
              {vatLabel(s.vat.treatment, s.vat.bps, pack.vatName ?? 'IVA')} <span className="badge ok">Exacto</span>
            </span>
            <b>{money(ex.vat)}</b>
          </div>
          <div className="row">
            <span className="dot" style={{ background: 'var(--warn)' }} />
            <span className="grow">
              Reserva renta {pct(s.reserveBps)} <span className={`badge ${precTone}`}>{precLabel}</span>
            </span>
            <b>{money(reserveOnly)}</b>
          </div>
        </div>
        <div className="card info">
          <p className="small" style={{ fontWeight: 600, color: 'var(--primary)' }}>
            ¿Por qué {pct(s.reserveBps)}?
          </p>
          <p className="small">
            Calculamos el impuesto sobre la renta de {countryName(pack.country)}
            {region ? ` (${pack.regions?.find((r) => r.id === region)?.name ?? region})` : ''} para {Number(revenue).toLocaleString('es-ES')} {pack.currency} al año
            {s.precision !== 'none' ? ' y añadimos un margen de seguridad según lo estricto que es el país' : ''}. Te avisaremos si se queda corta.
          </p>
        </div>
        {canFollow && (
          <div className="card">
            <div className="row">
              <div className="grow">
                <p style={{ fontWeight: 500 }}>Ajustar solo si cambia la ley</p>
                <p className="small muted">Si cambia el IVA, tu reparto se actualiza en la fecha oficial.</p>
              </div>
              <Toggle on={follow} onClick={() => setFollow(!follow)} label="Ajustar solo si cambia la ley" />
            </div>
          </div>
        )}
      </div>
      <div className="footer">
        <Button
          testid="create-vault"
          onClick={() =>
            run('Creando tu bóveda', async (step) => {
              const v = await createVault(chain, wallet!, plan, answers, step);
              if (follow && canFollow) {
                step('Activando "ajustar si cambia la ley" (confirma con tu wallet)');
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
          Crear mi bóveda
        </Button>
      </div>
    </>
  );
}
