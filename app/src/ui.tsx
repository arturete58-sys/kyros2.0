import { createContext, useContext, type ReactNode } from 'react';
import type { Chain } from './chain';
import type { Snapshot, VaultInfo } from './kyros';
import type { Wallet } from './wallet/types';

export interface Ctx {
  chain: Chain;
  wallet: Wallet | null;
  setWallet(w: Wallet | null): void;
  vault: VaultInfo | null;
  setVault(v: VaultInfo | null): void;
  snap: Snapshot | null;
  refresh(): Promise<void>;
  /** Runs `f` behind a progress overlay; shows the error if it fails. */
  run<T>(title: string, f: (step: (s: string) => void) => Promise<T>): Promise<T | undefined>;
  toast(msg: string): void;
  go(screen: Screen): void;
}

export type Screen = 'home' | 'request' | 'pay' | 'settings' | 'activity' | 'alerts';

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function Button(p: { kind?: 'primary' | 'secondary'; small?: boolean; onClick?: () => void; disabled?: boolean; children: ReactNode; testid?: string }) {
  return (
    <button data-testid={p.testid} className={`btn ${p.kind ?? 'primary'}${p.small ? ' small' : ''}`} onClick={p.onClick} disabled={p.disabled}>
      {p.children}
    </button>
  );
}

export function Option(p: { on: boolean; title: string; sub?: string; onClick: () => void; testid?: string }) {
  return (
    <button data-testid={p.testid} className={`option${p.on ? ' on' : ''}`} onClick={p.onClick}>
      <div>
        <div className="t">{p.title}</div>
        {p.sub && <div className="s">{p.sub}</div>}
      </div>
      <span className="radio" />
    </button>
  );
}

export function Seg<T extends string>(p: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {p.options.map(([v, l]) => (
        <button key={v} className={p.value === v ? 'on' : ''} onClick={() => p.onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Toggle(p: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return <button className={`toggle${p.on ? ' on' : ''}`} aria-label={p.label} aria-pressed={p.on} onClick={p.onClick} disabled={p.disabled} />;
}

export function Top(p: { onBack?: () => void; step?: number; of?: number }) {
  return (
    <div className="top">
      {p.onBack && (
        <button className="back" onClick={p.onBack} aria-label="Atrás">
          ‹
        </button>
      )}
      {p.step !== undefined && (
        <>
          <div className="steps">
            {Array.from({ length: p.of ?? 3 }, (_, i) => (
              <span key={i} className={i < p.step! ? 'on' : ''} />
            ))}
          </div>
          <span className="small muted">
            {p.step} de {p.of ?? 3}
          </span>
        </>
      )}
    </div>
  );
}

const icons: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  bell: (
    <>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
    </>
  ),
};

export function Tabs(p: { current: Screen }) {
  const { go } = useApp();
  const tabs: [Screen, string, string][] = [
    ['home', 'Inicio', 'home'],
    ['activity', 'Movimientos', 'list'],
    ['alerts', 'Avisos', 'bell'],
    ['settings', 'Ajustes', 'gear'],
  ];
  return (
    <nav className="tabs">
      {tabs.map(([s, l, i]) => (
        <button key={s} className={p.current === s ? 'on' : ''} onClick={() => go(s)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {icons[i]}
          </svg>
          {l}
        </button>
      ))}
    </nav>
  );
}

export function TxLink(p: { hash: string }) {
  const { chain } = useApp();
  return (
    <a href={chain.explorerTx(p.hash)} target="_blank" rel="noreferrer" className="small">
      Ver en el explorador →
    </a>
  );
}

export const pct = (bps: number) => `${(bps / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
