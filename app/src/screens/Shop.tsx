/**
 * Selling online: one payment address per VAT rate for a shop (WooCommerce)
 * or a pay-per-use API (x402), and the settings to paste into the plugin.
 */
import { useMemo, useState } from 'react';
import { EU_STANDARD_VAT, shopOwnRates, shopRatesNeeded } from 'kyros-sdk';
import { addShopInboxes, shopConfig } from '../kyros';
import { countryName } from '../packs';
import { t } from '../i18n';
import { Button, pct, Tabs, Top, useApp } from '../ui';

const GUIDE = 'https://github.com/arturete58-sys/kyros2.0/tree/main/plugins';

export function Shop() {
  const { vault, snap, chain, wallet, run, go, setVault } = useApp();
  const [oss, setOss] = useState(false);
  const [copied, setCopied] = useState(false);
  const pack = snap?.pack ?? null;
  const rates = useMemo(() => (pack && vault ? shopRatesNeeded(pack, { oss, presetId: vault.presetId }) : []), [pack, oss, vault]);
  const [picked, setPicked] = useState<Set<number> | null>(null);
  if (!vault || !wallet || !pack) return null;
  const own = new Set(shopOwnRates(pack, vault.presetId));
  const made = vault.shopInboxes ?? {};
  const chosen = picked ?? new Set(rates.filter((r) => own.has(r) || r === 0 || oss));
  const toMake = rates.filter((r) => chosen.has(r) && !made[r]);
  const label = (r: number) => {
    if (r === 0) return t('shopRateZero');
    if (own.has(r)) return t('shopRateOwn', { pct: pct(r) });
    const cs = Object.entries(EU_STANDARD_VAT)
      .filter(([, b]) => b === r)
      .map(([c]) => countryName(c));
    return t('shopRateEu', { pct: pct(r), countries: cs.join(', ') });
  };
  const config = JSON.stringify(shopConfig(chain, vault), null, 2);
  return (
    <>
      <div className="content" style={{ paddingBottom: 90 }}>
        <Top onBack={() => go('settings')} />
        <h1>{t('sellOnline')}</h1>
        <p className="muted">{t('shopSub')}</p>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={oss} data-testid="shop-oss" onChange={(e) => (setOss(e.target.checked), setPicked(null))} />
          {t('shopOss')}
        </label>
        <section className="card" data-testid="shop-rates">
          <p style={{ fontWeight: 600 }}>{t('shopRates')}</p>
          {rates.map((r) => (
            <label key={r} className="row small" style={{ gap: 8 }}>
              <input
                type="checkbox"
                disabled={!!made[r]}
                checked={!!made[r] || chosen.has(r)}
                onChange={(e) => {
                  const n = new Set(chosen);
                  if (e.target.checked) n.add(r);
                  else n.delete(r);
                  setPicked(n);
                }}
              />
              <span className="grow">{label(r)}</span>
              {made[r] && <span className="badge ok">{t('shopMade')}</span>}
            </label>
          ))}
          {toMake.length > 0 && (
            <Button
              testid="shop-create"
              onClick={() =>
                run(t('shopCreating'), async (step) => {
                  setVault(await addShopInboxes(chain, wallet, vault, toMake, step));
                  go('shop');
                })
              }
            >
              {t('shopCreate', { n: toMake.length })}
            </Button>
          )}
        </section>
        {Object.keys(made).length > 0 && (
          <section className="card" data-testid="shop-config">
            <p style={{ fontWeight: 600 }}>{t('shopConfig')}</p>
            <p className="small muted">{t('shopConfigSub')}</p>
            <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
              {config}
            </pre>
            <Button
              small
              kind="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(config);
                setCopied(true);
              }}
            >
              {copied ? t('shopCopied') : t('shopCopy')}
            </Button>
            <p className="tiny muted">{t('shopSweep')}</p>
            <a className="small" href={GUIDE} target="_blank" rel="noreferrer">
              {t('shopGuide')}
            </a>
          </section>
        )}
      </div>
      <Tabs current="settings" />
    </>
  );
}
