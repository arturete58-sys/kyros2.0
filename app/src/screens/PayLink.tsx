import { useState } from 'react';
import { Keypair, Operation } from '@stellar/stellar-sdk';
import { EVM_TESTNETS, formatAmount } from 'kyros-sdk';
import { finishCrossChain, payFromOtherChain, pendingCrossChain, simulateClientPayment, type PendingCrossChain } from '../kyros';
import { evmWallets, EvmWallet, type EvmWalletInfo } from '../wallet/evm';
import { Button, LangPicker, TxLink, useApp } from '../ui';
import { t } from '../i18n';
import { Logo } from '../brand';

/**
 * The page a client opens from a payment link. They pay the vault with the
 * invoice reference, from a Stellar wallet through the Router, or from
 * another chain through Circle's CCTP and the Kyros receiver.
 */
export function PayLink(p: { vault: string; refHex: string; amount: bigint }) {
  const { chain, run } = useApp();
  const [hash, setHash] = useState<string | null>(null);
  const [source, setSource] = useState<{ chain: string; url: string } | null>(null);
  const [evmChain, setEvmChain] = useState(EVM_TESTNETS[0].id);
  const [wallets, setWallets] = useState<EvmWalletInfo[] | null>(null);
  const [pending, setPending] = useState<PendingCrossChain | null>(() => {
    const x = pendingCrossChain();
    return x && x.vault === p.vault ? x : null;
  });
  const reference = Buffer.from(p.refHex, 'hex');
  const from = EVM_TESTNETS.find((c) => c.id === evmChain)!;

  const payFrom = (w: EvmWalletInfo) =>
    run(t('xcPaying', { chain: from.name }), async (step) => {
      const evm = await EvmWallet.connect(w);
      const r = await payFromOtherChain(chain, evm, from, { vault: p.vault, reference, amount: p.amount }, step);
      setSource({ chain: from.name, url: `${from.explorer}/tx/${r.burnTx}` });
      setPending(null);
      setHash(r.stellarTx);
    });

  return (
    <>
      <div className="content" style={{ justifyContent: 'center' }}>
        <LangPicker compact />
        <Logo />
        <h1>{t('invoicePayment')}</h1>
        <div className="card">
          <p className="small muted">{t('amount')}</p>
          <span className="big">{formatAmount(p.amount)} USDC</span>
          <p className="tiny muted mono">{t('toVault', { vault: p.vault })}</p>
        </div>
        <p className="small muted">{t('payLinkNote')}</p>
        {hash && (
          <div className="card ok" data-testid="paid">
            <p style={{ fontWeight: 600 }}>{t('paid')}</p>
            <TxLink hash={hash} />
            {source && (
              <a href={source.url} target="_blank" rel="noreferrer" className="small">
                {t('xcSourceTx', { chain: source.chain })}
              </a>
            )}
          </div>
        )}
        {!hash && pending && (
          <div className="card warn">
            <p className="small">{t('xcPending', { chain: pending.chainName })}</p>
            <a href={pending.explorer} target="_blank" rel="noreferrer" className="small">
              {t('xcSourceTx', { chain: pending.chainName })}
            </a>
            <Button
              small
              onClick={() =>
                run(t('xcPaying', { chain: pending.chainName }), async (step) => {
                  setSource({ chain: pending.chainName, url: pending.explorer });
                  setHash(await finishCrossChain(chain, pending, step));
                  setPending(null);
                })
              }
            >
              {t('xcFinish')}
            </Button>
          </div>
        )}
        {!hash && chain.cfg.cctp && (
          <div className="card" data-testid="cross-chain">
            <p style={{ fontWeight: 600 }}>{t('xcTitle')}</p>
            <p className="small muted">{t('xcSub')}</p>
            <div className="field">
              <label htmlFor="evm-chain">{t('xcNetwork')}</label>
              <select id="evm-chain" className="input" value={evmChain} onChange={(e) => setEvmChain(e.target.value)}>
                {EVM_TESTNETS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {wallets === null ? (
              <Button kind="secondary" small testid="find-evm-wallets" onClick={async () => setWallets(await evmWallets())}>
                {t('xcFind')}
              </Button>
            ) : wallets.length === 0 ? (
              <p className="small" data-testid="no-evm-wallets">
                {t('xcNoWallets')}
              </p>
            ) : (
              wallets.map((w) => (
                <button key={w.id} className="option" onClick={() => payFrom(w)}>
                  <div className="row">
                    {w.icon && <img src={w.icon} alt="" width={24} height={24} />}
                    <div className="t">{t('xcPayWith', { wallet: w.name })}</div>
                  </div>
                </button>
              ))
            )}
            <p className="tiny muted">{t('xcTestnetNote')}</p>
          </div>
        )}
      </div>
      {!hash && (
        <div className="footer">
          <Button
            onClick={() =>
              run(t('payingWithWallet'), async (step) => {
                const w = await (await import('../wallet/classic')).connectClassicWallet(chain);
                step(t('stepTestUsdc'));
                const issuer = Keypair.fromSecret(chain.cfg.faucetSecret);
                await chain.classicAs(issuer, [Operation.payment({ destination: w.address, asset: chain.asset('usd'), amount: formatAmount(p.amount + 10_000_000n) })]);
                step(t('confirmPayment'));
                setHash(await w.signAndSend(chain.client.payOp(chain.cfg.router, { from: w.address, vault: p.vault, token: chain.cfg.tokens.usd.contract, amount: p.amount, reference })));
              })
            }
          >
            {t('stellarWallet')}
          </Button>
          <Button kind="secondary" onClick={() => run(t('payingTestClient'), async () => setHash(await simulateClientPayment(chain, p.vault, p.amount, reference)))}>
            {t('simulatePayment')}
          </Button>
        </div>
      )}
    </>
  );
}
