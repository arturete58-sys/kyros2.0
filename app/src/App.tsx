import { useCallback, useEffect, useRef, useState } from 'react';
import { Chain } from './chain';
import { loadConfig, type AppConfig } from './config';
import { applyReadyCorrections, learnAbroadPayers, runDueScheduled, savedVault, snapshot, sweepInbox, type Snapshot, type VaultInfo } from './kyros';
import { AppCtx, type Ctx, type Screen } from './ui';
import { friendlyError } from './errors';
import { lazy, Suspense } from 'react';

// Screens load on demand: a client opening a payment link never downloads the owner's screens.
const Main = () => import('./screens/Main');
const Activity = lazy(() => Main().then((m) => ({ default: m.Activity })));
const Alerts = lazy(() => Main().then((m) => ({ default: m.Alerts })));
const Home = lazy(() => Main().then((m) => ({ default: m.Home })));
const Pay = lazy(() => Main().then((m) => ({ default: m.Pay })));
const Request = lazy(() => Main().then((m) => ({ default: m.Request })));
const Settings = lazy(() => Main().then((m) => ({ default: m.Settings })));
const Onboarding = lazy(() => import('./screens/Start').then((m) => ({ default: m.Onboarding })));
const Welcome = lazy(() => import('./screens/Start').then((m) => ({ default: m.Welcome })));
const PayLink = lazy(() => import('./screens/PayLink').then((m) => ({ default: m.PayLink })));
import type { Wallet } from './wallet/types';
import { getLang, setLang as applyLang, t, type Lang } from './i18n';
import { Logo } from './brand';

function payLinkFromHash(): { vault: string; refHex: string; amount: bigint } | null {
  const m = /^#pagar\?(.*)$/.exec(location.hash);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const v = q.get('v');
  const r = q.get('r');
  const a = q.get('a');
  return v && r && a ? { vault: v, refHex: r, amount: BigInt(a) } : null;
}

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [screen, setScreen] = useState<Screen>('home');
  const [busy, setBusy] = useState<{ title: string; step: string } | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean; detail?: string } | null>(null);
  const [lang, setLangState] = useState<Lang>(getLang());
  const payLink = payLinkFromHash();

  useEffect(() => {
    loadConfig()
      .then((c) => {
        setCfg(c);
        setChain(new Chain(c));
      })
      .catch((e: Error) => setCfgError(e.message));
  }, []);

  useEffect(() => {
    if (wallet && cfg && !(import.meta.env.DEV && location.hash.startsWith('#fixture'))) setVault(savedVault(wallet.address, cfg.deployedAt));
  }, [wallet, cfg]);

  // Development only: `#fixture-home`, `#fixture-pay`... show a screen with sample data and no network.
  const fixture = import.meta.env.DEV && location.hash.startsWith('#fixture') ? location.hash.slice(9) : null;
  useEffect(() => {
    if (!import.meta.env.DEV || fixture === null || !cfg) return;
    void (async () => {
      const f = await import('./dev/fixture');
      const { loadPack, loadHolidays } = await import('./packs');
      const pack = await loadPack('es');
      setWallet(f.fixtureWallet);
      if (fixture === 'start') return;
      setVault(f.fixtureVault());
      const snap = f.fixtureSnapshot(pack, await loadHolidays('es'));
      if (!fixture.startsWith('loading')) setSnap(fixture.startsWith('empty') ? f.emptySnapshot(snap) : snap);
      const screen = fixture.replace(/^(empty|loading)-?/, '');
      if (screen) setScreen(screen as Screen);
    })();
  }, [cfg, fixture]);

  // `#ui-test`: walk through the onboarding screens with a wallet that cannot sign (layout checks only).
  useEffect(() => {
    if (location.hash === '#ui-test' && !wallet)
      setWallet({
        kind: 'passkey',
        address: 'CUITEST',
        label: 'Test',
        signAndSend: async () => {
          throw new Error('wallet de prueba: no firma');
        },
        disconnect: async () => {},
      });
  }, [wallet]);

  const sweeping = useRef(false);
  const refresh = useCallback(async () => {
    if (!chain || !vault || (import.meta.env.DEV && location.hash.startsWith('#fixture'))) return;
    const s = await snapshot(chain, vault);
    setSnap(s);
    // Wallets that paid the address for clients abroad are remembered in this browser.
    if (learnAbroadPayers(vault, s)) setVault({ ...vault });
    // Payments sent straight to the payment address are split here, by this browser's fee payer,
    // and scheduled tax payments whose date has come are sent (anyone may run them).
    if (sweeping.current || location.hash === '#ui-test') return;
    sweeping.current = true;
    try {
      // Corrections whose notice has passed are applied too (VAT not owed goes back to the wallet).
      if ((await sweepInbox(chain, vault)) + (await runDueScheduled(chain, s, vault)) + (await applyReadyCorrections(chain, s, vault)) > 0) setSnap(await snapshot(chain, vault));
    } catch (e) {
      console.error('sweep', e);
    } finally {
      sweeping.current = false;
    }
  }, [chain, vault]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  if (cfgError)
    return (
      <main className="phone">
        <div className="content">
          <Logo />
          <p>{cfgError}</p>
        </div>
      </main>
    );
  if (!chain) return <main className="phone" aria-busy="true" />;

  const ctx: Ctx = {
    chain,
    wallet,
    setWallet,
    vault,
    setVault: (v) => {
      setVault(v);
      setScreen('home');
    },
    snap,
    refresh,
    toast: (msg) => setToast({ msg }),
    go: setScreen,
    lang,
    setLang: (l) => {
      applyLang(l);
      setLangState(l);
    },
    async run(title, f) {
      setBusy({ title, step: '' });
      try {
        const r = await f((step) => setBusy({ title, step }));
        return r;
      } catch (e) {
        const raw = (e as Error).message ?? String(e);
        console.error(e);
        // The end-to-end tests read the raw error to report it; people get it in plain words.
        setToast({ msg: friendlyError(e), error: true, detail: raw.slice(0, 600) });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
  };

  let page;
  if (payLink) page = <PayLink {...payLink} />;
  else if (!wallet) page = <Welcome />;
  else if (!vault) page = <Onboarding />;
  else if (screen === 'request') page = <Request />;
  else if (screen === 'pay') page = <Pay />;
  else if (screen === 'settings') page = <Settings />;
  else if (screen === 'activity') page = <Activity />;
  else if (screen === 'alerts') page = <Alerts />;
  else page = <Home />;

  return (
    <AppCtx.Provider value={ctx}>
      <main className="phone">
        <p className="testnet" role="status">{t('testnetBanner')}</p>
        <Suspense fallback={<div className="content" aria-busy="true" />}>{page}</Suspense>
      </main>
      {busy && (
        <div className="busy" role="status" data-testid="busy">
          <div className="card">
            <div className="row">
              <div className="spinner" />
              <b>{busy.title}</b>
            </div>
            {busy.step && <p className="small muted">{busy.step}</p>}
          </div>
        </div>
      )}
      {toast && (
        <div className={`toast${toast.error ? ' error' : ''}`} role="alert" aria-live="assertive" data-testid={toast.error ? 'error' : 'toast'} data-detail={toast.detail}>
          {toast.msg}
        </div>
      )}
    </AppCtx.Provider>
  );
}
