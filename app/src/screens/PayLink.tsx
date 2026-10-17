import { useState } from 'react';
import { Keypair, Operation } from '@stellar/stellar-sdk';
import { formatAmount } from 'kyros-sdk';
import { simulateClientPayment } from '../kyros';
import { Button, TxLink, useApp } from '../ui';

/** The page a client opens from a payment link: pays the vault through the Router, with the invoice reference. */
export function PayLink(p: { vault: string; refHex: string; amount: bigint }) {
  const { chain, run } = useApp();
  const [hash, setHash] = useState<string | null>(null);
  const reference = Buffer.from(p.refHex, "hex");
  return (
    <>
      <div className="content" style={{ justifyContent: 'center' }}>
        <div className="logo">Kyros</div>
        <h1>Pago de factura</h1>
        <div className="card">
          <p className="small muted">Importe</p>
          <span className="big">{formatAmount(p.amount)} USDC</span>
          <p className="tiny muted mono">Para la bóveda {p.vault}</p>
        </div>
        <p className="small muted">El pago se reparte al instante: el vendedor recibe su parte y su IVA queda apartado. Red de pruebas: el dinero no es real.</p>
        {hash && (
          <div className="card ok">
            <p style={{ fontWeight: 600 }}>Pagado</p>
            <TxLink hash={hash} />
          </div>
        )}
      </div>
      {!hash && (
        <div className="footer">
          <Button
            onClick={() =>
              run('Pagando con tu wallet', async (step) => {
                const w = await (await import('../wallet/classic')).connectClassicWallet(chain);
                step('Consiguiendo USDC de prueba para tu wallet');
                const issuer = Keypair.fromSecret(chain.cfg.faucetSecret);
                await chain.classicAs(issuer, [Operation.payment({ destination: w.address, asset: chain.asset('usd'), amount: formatAmount(p.amount + 10_000_000n) })]);
                step('Confirma el pago en tu wallet');
                setHash(await w.signAndSend(chain.client.payOp(chain.cfg.router, { from: w.address, vault: p.vault, token: chain.cfg.tokens.usd.contract, amount: p.amount, reference })));
              })
            }
          >
            Pagar con mi wallet
          </Button>
          <Button kind="secondary" onClick={() => run('Pagando con un cliente de pruebas', async () => setHash(await simulateClientPayment(chain, p.vault, p.amount, reference)))}>
            Simular el pago
          </Button>
        </div>
      )}
    </>
  );
}
