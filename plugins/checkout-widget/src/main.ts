/**
 * <kyros-checkout>: pays an order from the buyer's Stellar wallet.
 *
 * The shop's server says what to pay: one transfer per VAT rate, each into
 * the seller's Kyros payment address for that rate. The buyer's wallet signs
 * each transfer; after each one the widget sends the transaction hash to the
 * shop, which checks it on chain and marks that part paid. The seller's vault
 * splits every payment on arrival: VAT and income-tax reserve locked, the
 * rest to the seller. The widget never sees a key and has no server.
 *
 *   <script src="kyros-checkout.js"></script>
 *   <kyros-checkout network="testnet" asset-contract="C..." asset-code="USDC"
 *     payments='[{"inbox":"C...","bps":2100,"amount":"121000000"}]'
 *     status-url="https://shop.example/wp-json/kyros/v1/orders/123" order-key="wc_order_..."
 *     return-url="https://shop.example/checkout/order-received/123"></kyros-checkout>
 */
import { Buffer } from 'buffer';
import { Address, Contract, nativeToScVal, rpc, TransactionBuilder, Networks as StellarNetworks } from '@stellar/stellar-sdk';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { Networks } from '@creit.tech/stellar-wallets-kit/types';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

interface Payment {
  inbox: string;
  bps: number;
  /** Token units (7 decimals), as a string. */
  amount: string;
}

interface Status {
  paid: string[];
  complete: boolean;
  redirect?: string;
  error?: string;
}

type Lang = 'es' | 'en' | 'pt' | 'fr' | 'de' | 'it';
const TEXT: Record<string, Record<Lang, string>> = {
  title: { es: 'Pagar con stablecoins en Stellar', en: 'Pay with stablecoins on Stellar', pt: 'Pagar com stablecoins na Stellar', fr: 'Payer en stablecoins sur Stellar', de: 'Mit Stablecoins auf Stellar bezahlen', it: 'Paga in stablecoin su Stellar' },
  total: { es: 'Total', en: 'Total', pt: 'Total', fr: 'Total', de: 'Gesamt', it: 'Totale' },
  vat: { es: 'con IVA {pct}', en: 'with {pct} VAT', pt: 'com IVA {pct}', fr: 'TVA {pct} incluse', de: 'inkl. {pct} USt.', it: 'IVA {pct} inclusa' },
  noVat: { es: 'sin IVA', en: 'no VAT', pt: 'sem IVA', fr: 'sans TVA', de: 'ohne USt.', it: 'senza IVA' },
  pay: { es: 'Pagar con mi wallet', en: 'Pay with my wallet', pt: 'Pagar com a minha wallet', fr: 'Payer avec mon wallet', de: 'Mit meiner Wallet bezahlen', it: 'Paga con il mio wallet' },
  several: { es: 'Tu pedido tiene {n} tipos de IVA: tu wallet te pedirá {n} firmas, una por cada uno.', en: 'Your order has {n} VAT rates: your wallet will ask for {n} signatures, one each.', pt: 'A tua encomenda tem {n} taxas de IVA: a wallet vai pedir {n} assinaturas, uma por cada.', fr: 'Votre commande a {n} taux de TVA : votre wallet demandera {n} signatures, une par taux.', de: 'Deine Bestellung hat {n} Steuersätze: Deine Wallet fragt {n} Signaturen ab, eine pro Satz.', it: 'Il tuo ordine ha {n} aliquote IVA: il wallet chiederà {n} firme, una per ciascuna.' },
  signing: { es: 'Firma el pago {i} de {n} en tu wallet…', en: 'Sign payment {i} of {n} in your wallet…', pt: 'Assina o pagamento {i} de {n} na wallet…', fr: 'Signez le paiement {i} sur {n} dans votre wallet…', de: 'Signiere Zahlung {i} von {n} in deiner Wallet…', it: 'Firma il pagamento {i} di {n} nel wallet…' },
  confirming: { es: 'Confirmando en la red…', en: 'Confirming on the network…', pt: 'A confirmar na rede…', fr: 'Confirmation sur le réseau…', de: 'Wird im Netzwerk bestätigt…', it: 'Conferma sulla rete…' },
  checking: { es: 'La tienda está comprobando el pago…', en: 'The shop is checking the payment…', pt: 'A loja está a verificar o pagamento…', fr: 'La boutique vérifie le paiement…', de: 'Der Shop prüft die Zahlung…', it: 'Il negozio sta verificando il pagamento…' },
  done: { es: 'Pago completado. Gracias.', en: 'Payment complete. Thank you.', pt: 'Pagamento concluído. Obrigado.', fr: 'Paiement effectué. Merci.', de: 'Zahlung abgeschlossen. Danke.', it: 'Pagamento completato. Grazie.' },
  paidPart: { es: 'pagado', en: 'paid', pt: 'pago', fr: 'payé', de: 'bezahlt', it: 'pagato' },
  funds: { es: 'Tu wallet no tiene suficiente {code} en Stellar, o no puede recibir este activo. Revísalo e inténtalo de nuevo.', en: 'Your wallet does not have enough {code} on Stellar, or does not hold this asset. Check it and try again.', pt: 'A tua wallet não tem {code} suficiente na Stellar, ou não tem este ativo. Verifica e tenta de novo.', fr: 'Votre wallet n’a pas assez de {code} sur Stellar, ou ne détient pas cet actif. Vérifiez et réessayez.', de: 'Deine Wallet hat nicht genug {code} auf Stellar oder hält dieses Asset nicht. Prüfe es und versuche es erneut.', it: 'Il tuo wallet non ha abbastanza {code} su Stellar, o non detiene questo asset. Controlla e riprova.' },
  failed: { es: 'No se ha podido completar el pago: {why}', en: 'The payment could not be completed: {why}', pt: 'Não foi possível concluir o pagamento: {why}', fr: 'Le paiement n’a pas pu aboutir : {why}', de: 'Die Zahlung konnte nicht abgeschlossen werden: {why}', it: 'Impossibile completare il pagamento: {why}' },
  note: { es: 'Pagas directamente al vendedor. Kyros aparta su IVA e impuestos al llegar el pago; nadie más toca tu dinero.', en: 'You pay the seller directly. Kyros sets their VAT and taxes aside as the payment arrives; nobody else touches your money.', pt: 'Pagas diretamente ao vendedor. A Kyros separa o IVA e os impostos dele quando o pagamento chega; mais ninguém toca no teu dinheiro.', fr: 'Vous payez le vendeur directement. Kyros met de côté sa TVA et ses impôts à l’arrivée du paiement ; personne d’autre ne touche votre argent.', de: 'Du zahlst direkt an den Verkäufer. Kyros legt seine Steuern beim Eingang zurück; sonst berührt niemand dein Geld.', it: 'Paghi direttamente il venditore. Kyros accantona IVA e imposte all’arrivo del pagamento; nessun altro tocca il tuo denaro.' },
};

// Mainnet has no public RPC run by SDF: the shop sets its provider in the `rpc` attribute.
const RPC: Record<string, string> = { testnet: 'https://soroban-testnet.stellar.org', pubnet: '' };
const PASSPHRASE: Record<string, string> = { testnet: StellarNetworks.TESTNET, pubnet: StellarNetworks.PUBLIC };

const fmt = (units: bigint, lang: string) =>
  (Number(units) / 1e7).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 7 });

class KyrosCheckout extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private status: Status = { paid: [], complete: false };
  private busy = false;
  private message = '';
  private error = '';

  private get language(): Lang {
    const l = (this.getAttribute('lang') || document.documentElement.lang || navigator.language || 'en').slice(0, 2) as Lang;
    return l in TEXT.title ? l : 'en';
  }
  private t(k: keyof typeof TEXT, v: Record<string, string | number> = {}): string {
    let s = TEXT[k][this.language];
    for (const [a, b] of Object.entries(v)) s = s.split(`{${a}}`).join(String(b));
    return s;
  }
  private get payments(): Payment[] {
    try {
      return JSON.parse(this.getAttribute('payments') || '[]') as Payment[];
    } catch {
      return [];
    }
  }
  private get network() {
    return this.getAttribute('network') === 'pubnet' ? 'pubnet' : 'testnet';
  }

  connectedCallback() {
    this.render();
    void this.refresh();
  }

  /** What the shop already has as paid (after a reload, or a payment in two steps). */
  private async refresh(hash?: string) {
    const url = this.getAttribute('status-url');
    if (!url) return;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: this.getAttribute('order-key') ?? '', hash: hash ?? null }),
    });
    const s = (await r.json()) as Status;
    if (!r.ok || s.error) throw new Error(s.error || `HTTP ${r.status}`);
    this.status = s;
    this.render();
    if (s.complete) {
      this.message = this.t('done');
      this.render();
      const to = s.redirect || this.getAttribute('return-url');
      if (to) setTimeout(() => (location.href = to), 1200);
    }
  }

  private async pay() {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const network = this.network;
      StellarWalletsKit.init({ modules: defaultModules(), network: network === 'pubnet' ? Networks.PUBLIC : Networks.TESTNET });
      const { address } = await StellarWalletsKit.authModal();
      const rpcUrl = this.getAttribute('rpc') || RPC[network];
      if (!rpcUrl) throw new Error(this.t('failed', { why: 'no Stellar RPC set for mainnet' }));
      const server = new rpc.Server(rpcUrl);
      const token = new Contract(this.getAttribute('asset-contract') ?? '');
      const todo = this.payments.filter((p) => !this.status.paid.includes(p.inbox));
      for (const [i, p] of todo.entries()) {
        this.message = this.t('signing', { i: i + 1, n: todo.length });
        this.render();
        const op = token.call('transfer', new Address(address).toScVal(), new Address(p.inbox).toScVal(), nativeToScVal(BigInt(p.amount), { type: 'i128' }));
        let prepared;
        try {
          const tx = new TransactionBuilder(await server.getAccount(address), { fee: '1000000', networkPassphrase: PASSPHRASE[network] }).addOperation(op).setTimeout(300).build();
          prepared = await server.prepareTransaction(tx);
        } catch {
          throw new Error(this.t('funds', { code: this.getAttribute('asset-code') ?? 'USDC' }));
        }
        const { signedTxXdr } = await StellarWalletsKit.signTransaction(prepared.toXDR(), { networkPassphrase: PASSPHRASE[network], address });
        const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE[network]));
        if (sent.status === 'ERROR') throw new Error(this.t('failed', { why: 'the network refused the transaction' }));
        this.message = this.t('confirming');
        this.render();
        const res = await server.pollTransaction(sent.hash, { attempts: 30 });
        if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(this.t('failed', { why: res.status }));
        this.message = this.t('checking');
        this.render();
        await this.refresh(sent.hash);
      }
    } catch (e) {
      this.error = (e as Error).message || String(e);
    } finally {
      this.busy = false;
      if (!this.status.complete) this.message = '';
      this.render();
    }
  }

  private render() {
    const ps = this.payments;
    const total = ps.reduce((a, p) => a + BigInt(p.amount), 0n);
    const code = this.getAttribute('asset-code') ?? 'USDC';
    const pct = (bps: number) => `${(bps / 100).toLocaleString(this.language)} %`;
    const rows = ps
      .map((p) => {
        const paid = this.status.paid.includes(p.inbox);
        return `<li class="${paid ? 'paid' : ''}"><span>${p.bps ? this.t('vat', { pct: pct(p.bps) }) : this.t('noVat')}</span><b>${fmt(BigInt(p.amount), this.language)} ${code}${paid ? ` · ${this.t('paidPart')}` : ''}</b></li>`;
      })
      .join('');
    this.root.innerHTML = `
      <style>
        :host { display: block; font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; color: inherit; max-width: 460px; }
        .box { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        h3 { margin: 0; font-size: 16px; }
        ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        li { display: flex; justify-content: space-between; gap: 12px; }
        li.paid { opacity: .6; }
        .total { display: flex; justify-content: space-between; font-weight: 600; border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); padding-top: 8px; }
        button { font: inherit; font-weight: 600; padding: 12px 16px; border-radius: 10px; border: 0; background: #2e4a6c; color: #fff; cursor: pointer; }
        button[disabled] { opacity: .6; cursor: default; }
        .muted { opacity: .7; font-size: 13px; margin: 0; }
        .msg { margin: 0; }
        .err { margin: 0; color: #b42318; }
      </style>
      <div class="box" part="box">
        <h3>${this.t('title')}</h3>
        <ul>${rows}</ul>
        <div class="total"><span>${this.t('total')}</span><span>${fmt(total, this.language)} ${code}</span></div>
        ${ps.length > 1 && !this.status.complete ? `<p class="muted">${this.t('several', { n: ps.length })}</p>` : ''}
        ${this.status.complete ? '' : `<button part="button" ${this.busy ? 'disabled' : ''}>${this.t('pay')}</button>`}
        ${this.message ? `<p class="msg" role="status">${this.message}</p>` : ''}
        ${this.error ? `<p class="err" role="alert">${this.error}</p>` : ''}
        <p class="muted">${this.t('note')}</p>
      </div>`;
    this.root.querySelector('button')?.addEventListener('click', () => void this.pay());
  }
}

if (!customElements.get('kyros-checkout')) customElements.define('kyros-checkout', KyrosCheckout);
