import { useCallback, useEffect, useRef, useState } from 'react';
import { Chain } from './chain';
import { loadConfig, type AppConfig } from './config';
import { savedVault, snapshot, sweepInbox, type Snapshot, type VaultInfo } from './kyros';
import { AppCtx, type Ctx, type Screen } from './ui';
import { Activity, Alerts, Home, Pay, Request, Settings } from './screens/Main';
import { Onboarding, Welcome } from './screens/Start';
import { PayLink } from './screens/PayLink';
import type { Wallet } from './wallet/types';
import { getLang, setLang as applyLang, t, type Lang } from './i18n';

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
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
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
    if (wallet && cfg) setVault(savedVault(wallet.address, cfg.deployedAt));
  }, [wallet, cfg]);

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
    if (!chain || !vault) return;
    setSnap(await snapshot(chain, vault));
    // Payments sent straight to the payment address are split here, by this browser's fee payer.
    if (sweeping.current || location.hash === '#ui-test') return;
    sweeping.current = true;
    try {
      if ((await sweepInbox(chain, vault)) > 0) setSnap(await snapshot(chain, vault));
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
      <div className="phone">
        <div className="content">
          <div className="logo">Kyros</div>
          <p>{cfgError}</p>
        </div>
      </div>
    );
  if (!chain) return <div className="phone" />;

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
        const m = (e as Error).message ?? String(e);
        setToast({ msg: m.length > 240 ? `${m.slice(0, 240)}…` : m, error: true });
        console.error(e);
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
      <div className="phone">
        <div className="testnet">{t('testnetBanner')}</div>
        {page}
      </div>
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
        <div className={`toast${toast.error ? ' error' : ''}`} role="alert" data-testid={toast.error ? 'error' : 'toast'}>
          {toast.msg}
        </div>
      )}
    </AppCtx.Provider>
  );
}
