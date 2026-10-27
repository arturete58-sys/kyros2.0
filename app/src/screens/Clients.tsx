/**
 * One payment address per client. A swept inbox cannot tell who paid, so
 * clients with different VAT must not share one: each gets their own,
 * registered in the vault with that client's VAT and withholding.
 */
import { useEffect, useMemo, useState } from 'react';
import { EU_STANDARD_VAT } from 'kyros-sdk';
import { addClient, clientTermsNow, sameTerms, updateClient, type ClientAddress } from '../kyros';
import { countries, countryName } from '../packs';
import { t } from '../i18n';
import { Button, pct, Tabs, Top, useApp } from '../ui';

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

export function treatmentText(c: ClientAddress, home: string): string {
  const v = c.terms;
  let s: string;
  if (v.treatment === 'reverse-charge') s = t('clientReverse');
  else if (v.treatment === 'outside-eu') s = t('clientExport');
  else if (v.treatment === 'export') s = t('clientExportNonEu');
  else if (v.treatment === 'oss-buyer-country' && c.country !== home) s = t('clientVatOf', { country: countryName(c.country), pct: pct(v.vatBps) });
  else s = t('clientVat', { pct: pct(v.vatBps) });
  return v.withholdingBps ? `${s} · ${t('clientWithheld', { pct: pct(v.withholdingBps) })}` : s;
}

function ClientRow({ c }: { c: ClientAddress }) {
  const { vault, snap, chain, wallet, run, setVault, go } = useApp();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    import('qrcode').then((q) => q.toDataURL(c.inbox, { margin: 1, width: 200 }).then(setQr)).catch(() => setQr(null));
  }, [c.inbox]);
  if (!vault || !snap?.pack) return null;
  const home = snap.pack.country;
  const outdated = !sameTerms(c.terms, clientTermsNow(vault, snap.pack, c));
  return (
    <div className="item" style={{ alignItems: 'flex-start' }} data-testid="client">
      {qr && <img src={qr} alt="" width={72} height={72} style={{ borderRadius: 6, flex: 'none' }} />}
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <b>{c.name}</b>
        <span className="small muted">
          {countryName(c.country)} · {treatmentText(c, home)}
        </span>
        <span className="tiny mono" title={c.inbox} data-testid="client-address">
          {short(c.inbox)}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="link small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(c.inbox);
                setCopied(true);
              } catch {
                /* selectable above */
              }
            }}
          >
            {copied ? t('copied') : t('copy')}
          </button>
          {'share' in navigator && (
            <button className="link small" onClick={() => navigator.share?.({ title: 'Kyros', text: t('clientShareText', { address: c.inbox }) }).catch(() => {})}>
              {t('share')}
            </button>
          )}
        </div>
        {outdated && wallet && (
          <div className="row small" style={{ gap: 8 }}>
            <span>{t('clientOutdated')}</span>
            <Button
              small
              kind="secondary"
              onClick={() =>
                run(t('clientSigning'), async () => {
                  setVault(await updateClient(chain, wallet, vault, snap.pack!, c.id));
                  go('clients');
                })
              }
            >
              {t('clientUpdate')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Clients() {
  const { vault, snap, chain, wallet, run, go, setVault, lang } = useApp();
  const all = useMemo(countries, [lang]);
  const home = snap?.pack?.country ?? vault?.answers.packId.toUpperCase() ?? 'ES';
  const [name, setName] = useState('');
  const [country, setCountry] = useState(home);
  const [business, setBusiness] = useState(true);
  const [vatId, setVatId] = useState('');
  const [withholding, setWithholding] = useState('');
  const [oss, setOss] = useState(false);
  if (!vault || !wallet) return null;
  const eu = country in EU_STANDARD_VAT;
  const abroadEu = eu && country !== home;
  const ready = !!snap?.pack && name.trim().length > 0;
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('home')} />
        <h1>{t('clientsTitle')}</h1>
        <p className="muted">{t('clientsSub')}</p>
        <p className="small muted">{t('clientsWhy')}</p>
        <div className="list" data-testid="clients">
          {(vault.clients ?? []).length === 0 && <p className="small muted">{t('clientNone')}</p>}
          {(vault.clients ?? []).map((c) => (
            <ClientRow key={c.id} c={c} />
          ))}
        </div>
        <section className="card" data-testid="client-form">
          <div className="field">
            <label htmlFor="client-name">{t('clientName')}</label>
            <input id="client-name" data-testid="client-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="client-country">{t('clientCountry')}</label>
            <select id="client-country" data-testid="client-country" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
              {/* Every country, not only those with a rule pack: a client can be anywhere. */}
              {[...new Set([...all.map((c) => c.country), ...Object.keys(EU_STANDARD_VAT)])]
                .map((c) => ({ c, n: countryName(c) }))
                .sort((a, b) => a.n.localeCompare(b.n))
                .map(({ c, n }) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
            </select>
          </div>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} />
            {t('clientBusiness')}
          </label>
          {business && abroadEu && (
            <div className="field">
              <label htmlFor="client-vat">{t('clientVatId')}</label>
              <input id="client-vat" data-testid="client-vat" className="input mono" value={vatId} placeholder={`${country}…`} onChange={(e) => setVatId(e.target.value.toUpperCase().replace(/\s/g, ''))} />
              <span className="tiny muted">{t('clientVatIdHelp')}</span>
            </div>
          )}
          {business && country === home && (
            <div className="field">
              <label htmlFor="client-wh">{t('clientWithholding')}</label>
              <input id="client-wh" className="input" inputMode="decimal" value={withholding} placeholder="0" onChange={(e) => setWithholding(e.target.value.replace(/[^\d.,]/g, ''))} />
              <span className="tiny muted">{t('clientWithholdingHelp')}</span>
            </div>
          )}
          {!business && abroadEu && (
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={oss} onChange={(e) => setOss(e.target.checked)} />
              {t('clientOss')}
            </label>
          )}
          <Button
            testid="client-add"
            disabled={!ready}
            onClick={() =>
              run(t('clientAdding'), async (step) => {
                const wh = business && country === home ? Math.round(Number(withholding.replace(',', '.') || '0') * 100) : 0;
                setVault(
                  await addClient(
                    chain,
                    wallet,
                    vault,
                    snap!.pack!,
                    { name: name.trim(), country, business, vatId: business && abroadEu && vatId ? vatId : undefined, withholdingBps: wh, oss: !business && abroadEu && oss },
                    step,
                  ),
                );
                setName('');
                setVatId('');
                setWithholding('');
                go('clients');
              })
            }
          >
            {t('clientAdd')}
          </Button>
        </section>
      </div>
      <Tabs current="home" />
    </>
  );
}
