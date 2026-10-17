import { useState } from 'react';
import { Keypair, Operation } from '@stellar/stellar-sdk';
import { formatAmount } from 'kyros-sdk';
import { simulateClientPayment } from '../kyros';
import { Button, LangPicker, TxLink, useApp } from '../ui';
import { t } from '../i18n';

/** The page a client opens from a payment link: pays the vault through the Router, with the invoice reference. */
export function PayLink(p: { vault: string; refHex: string; amount: bigint }) {
  const { chain, run } = useApp();
  const [hash, setHash] = useState<string | null>(null);
  const reference = Buffer.from(p.refHex, 'hex');
  return (
    <>
      <div className="content" style={{ justifyContent: 'center' }}>
        <LangPicker compact />
        <div className="logo">Kyros</div>
        <h1>{t('invoicePayment')}</h1>
        <div className="card">
          <p className="small muted">{t('amount')}</p>
          <span className="big">{formatAmount(p.amount)} USDC</span>
          <p className="tiny muted mono">{t('toVault', { vault: p.vault })}</p>
        </div>
        <p className="small muted">{t('payLinkNote')}</p>
        {hash && (
          <div className="card ok">
            <p style={{ fontWeight: 600 }}>{t('paid')}</p>
            <TxLink hash={hash} />
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
            {t('payWithWallet')}
          </Button>
          <Button kind="secondary" onClick={() => run(t('payingTestClient'), async () => setHash(await simulateClientPayment(chain, p.vault, p.amount, reference)))}>
            {t('simulatePayment')}
          </Button>
        </div>
      )}
    </>
  );
}
