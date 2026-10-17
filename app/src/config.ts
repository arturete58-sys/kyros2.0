/** What the testnet deployment workflow wrote (app/public/testnet.json). */
export interface AppConfig {
  network: 'testnet';
  rpcUrl: string;
  networkPassphrase: string;
  deployedAt: string;
  noticeSecs: number;
  wasm: { vault: string; inbox: string };
  router: string;
  registry: string;
  tokens: { usd: Token; eur: Token };
  faucetSecret: string;
  taxAccount: string;
  conversion: { swapper: string; oracle: string; eurUsdAtDeploy: string | null } | null;
  passkeyWalletWasmHash: string;
}

export interface Token {
  code: string;
  issuer: string;
  contract: string;
}

export async function loadConfig(): Promise<AppConfig> {
  const r = await fetch(`${import.meta.env.BASE_URL}testnet.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error('Kyros todavía no está desplegado en testnet (falta testnet.json).');
  return (await r.json()) as AppConfig;
}
