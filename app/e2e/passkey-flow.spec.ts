import { expect, test, type Page } from '@playwright/test';

/** A platform authenticator that answers every passkey prompt, as Face ID would. */
async function virtualFaceId(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

const consoleErrors: string[] = [];
const moveLog: string[] = [];

async function settle(page: Page) {
  await expect(page.getByTestId('busy')).toHaveCount(0, { timeout: 300_000 });
  const err = page.getByTestId('error');
  // The browser's errors go into the message, so CI shows them in the run's annotations.
  if (await err.count()) throw new Error(`app error: ${await err.textContent()} | ${await err.getAttribute('data-detail')}\n${consoleErrors.slice(-5).join('\n')}`);
}

const amountOf = async (page: Page, testid: string) => Number(((await page.getByTestId(testid).locator('.big, .amount').first().textContent()) ?? '0').replace(/[^\d,]/g, '').replace(',', '.'));

test('a freelancer signs up with a passkey, gets paid, registers an expected payment and pays the tax', async ({ page }) => {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 1500)));
  page.on('console', (m) => m.text().startsWith('[move]') && moveLog.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => consoleErrors.push(String(e.stack ?? e).slice(0, 1500)));
  await virtualFaceId(page);
  await page.goto('./');

  await page.getByLabel('Tu nombre (solo si usas Face ID)').fill('Prueba e2e');
  await page.getByTestId('create-passkey').click();
  await settle(page);
  await expect(page.getByText('¿Dónde vives la mayor parte del año?')).toBeVisible();

  await page.getByTestId('next-1').click();
  await page.getByTestId('activity-software').click();
  await page.getByTestId('next-2').click();
  await page.getByTestId('client-business-local').click();
  await page.getByTestId('next-3').click();
  await expect(page.getByText('Tu plan está listo')).toBeVisible();
  await page.getByTestId('create-vault').click();
  await settle(page);
  await expect(page.getByTestId('spendable')).toBeVisible();

  // A test client pays 1,210: part arrives in the wallet, the rest stays in the vault.
  await page.getByTestId('simulate-payment').click();
  await settle(page);
  await expect.poll(() => amountOf(page, 'spendable'), { timeout: 120_000 }).toBeGreaterThan(0);
  const reserved = await amountOf(page, 'reserved');
  expect(reserved).toBeGreaterThan(0);

  // An expected payment with IRPF withheld: the passkey signs expect_invoice, then the client pays 1,060.
  await page.getByTestId('request').click();
  await page.getByTestId('register-request').click();
  await settle(page);
  await expect(page.getByText('Cobro registrado en tu bóveda')).toBeVisible();
  await page.getByTestId('simulate-request-payment').click();
  await settle(page);
  await expect(page.getByTestId('spendable')).toBeVisible();

  // Pay the tax from the vault: the passkey signs each payment.
  await page.getByRole('button', { name: 'Pagar', exact: true }).click();
  await page.getByTestId('pay-taxes').click();
  await settle(page);
  await expect(page.getByText('Ver en el explorador →').first()).toBeVisible();

  // The deadlines say how weekends and holidays move them.
  await expect(page.getByTestId('workdays-note').first()).toBeVisible();

  // A letter from the tax office: the app reads it, the vault takes its date (set_due, signed with
  // the passkey) and the payment is scheduled to go out by itself; then it is cancelled.
  const y = new Date().getUTCFullYear();
  await page.getByTestId('notice-text').fill(`Liquidación provisional. Fecha de emisión: 02/05/${y}. Importe a ingresar: 20,00 euros. Plazo de ingreso: hasta el 22 de junio de ${y + 2}.`);
  await page.getByTestId('notice-read').click();
  await expect(page.getByTestId('notice-date')).toHaveValue(`${y + 2}-06-22`);
  await expect(page.getByTestId('notice-amount')).toHaveValue('20.00');
  await page.getByTestId('notice-year').selectOption({ label: String(y) });
  await page.getByTestId('notice-apply').click();
  await settle(page);
  await expect(page.getByTestId('notice-done')).toBeVisible();
  await expect(page.getByTestId('scheduled')).toBeVisible();
  await page.getByTestId('scheduled').getByRole('button', { name: 'Cancelar' }).click();
  await settle(page);
  await expect(page.getByTestId('scheduled')).toHaveCount(0);

  // Clients abroad: the second payment address is made on first use (the passkey signs that the
  // vault books its payments without VAT).
  await page.locator('button.back').click();
  await page.getByTestId('addr-abroad').click();
  await page.getByTestId('make-abroad').click();
  await settle(page);
  await expect(page.getByTestId('pay-address').getByTestId('address')).toHaveText(/^C[A-Z0-9]{7}…/);

  // The assistant answers from the vault, reads an invoice on the device, and the passkey signs its terms.
  await page.getByRole('button', { name: 'Asistente' }).click();
  await expect(page.getByTestId('msg-assistant').first()).toContainText('asistente de Kyros');
  await page.getByTestId('assistant-input').fill('¿Cuándo es mi próximo plazo?');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('msg-assistant').last()).toContainText('Tus próximos plazos');
  await page.getByTestId('assistant-file').setInputFiles({
    name: 'factura.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`FACTURA Nº E2E-${Date.now()} Base imponible 100,00 € IVA 21% 21,00 € Retención IRPF 15% -15,00 € Total a pagar 106,00 €`),
  });
  await expect(page.getByTestId('msg-assistant').last()).toContainText('retención del cliente 15');
  await page.getByTestId('act-register-invoice').last().click();
  await settle(page);
  await expect(page.getByTestId('msg-assistant').last()).toContainText('Hecho');

  // Expenses and deductions: a supplier invoice typed by hand, and what it saves under Spain's rules.
  await page.getByRole('button', { name: 'Inicio' }).click();
  await page.getByTestId('expenses-card').click();
  await page.getByTestId('expense-hand').click();
  await page.getByTestId('expense-base').fill('1000');
  await page.getByTestId('expense-vat').fill('210');
  await page.getByTestId('expense-save').click();
  await expect(page.getByTestId('ded-expenses')).toContainText('1000,00');
  await expect(page.getByTestId('deductions')).toContainText('pagas sobre el beneficio');

  // Input VAT: a new payment puts VAT in the reserve, and the VAT on the expense comes back from it
  // (a correction the passkey signs; it applies by itself after the notice).
  await page.getByRole('button', { name: 'Inicio' }).click();
  await page.getByTestId('simulate-payment').click();
  await settle(page);
  await page.getByTestId('expenses-card').click();
  await expect(page.getByTestId('input-vat')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('input-vat-reclaim').click();
  await settle(page);
  await expect(page.getByTestId('expense-list')).toContainText('IVA recuperado');

  // A fixed monthly fee (the self-employed fee) and another payout address, both with notice;
  // the pending changes are shown and cancelled together.
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByTestId('fixed-link').click();
  await page.getByTestId('fixed-monthly').fill('300');
  await page.getByTestId('fixed-save').click();
  await settle(page);
  await expect(page.getByTestId('fixed-pending')).toContainText('900,00');
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByTestId('payout-link').click();
  await expect(page.getByTestId('payout-now')).toContainText('la cartera que firma');
  const payoutCfg = await (await page.request.get('./testnet.json')).json();
  await page.getByTestId('payout-new').fill(payoutCfg.taxAccount);
  await page.getByTestId('payout-save').click();
  await settle(page);
  await expect(page.getByTestId('payout-pending')).toContainText(payoutCfg.taxAccount.slice(0, 8));
  await page.getByTestId('payout-pending').getByRole('button', { name: 'Cancelar el cambio' }).click();
  await settle(page);
  await expect(page.getByTestId('payout-pending')).toHaveCount(0);

  // Selling online: one payment address per VAT rate (the passkey signs each one's terms),
  // and the settings for the WooCommerce plugin or an x402 server.
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByTestId('sell-online').click();
  await page.getByTestId('shop-create').click();
  await settle(page);
  await expect(page.getByTestId('shop-config')).toContainText('"2100": "C');

  // One payment address per client: a German business with its VAT number pays into its own
  // address, registered without VAT (reverse charge); the passkey signs its terms.
  await page.getByRole('button', { name: 'Inicio' }).click();
  await page.getByTestId('clients-link').click();
  await page.getByTestId('client-name').fill('Müller GmbH');
  await page.getByTestId('client-country').selectOption('DE');
  await page.getByTestId('client-vat').fill('DE123456789');
  await page.getByTestId('client-add').click();
  await settle(page);
  await expect(page.getByTestId('client')).toContainText('Sin IVA: inversión del sujeto pasivo');

  // Another wallet of the same business: read only, its income counts too.
  const cfg = await (await page.request.get('./testnet.json')).json();
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByTestId('business-wallets').click();
  await page.getByTestId('wallet-address').fill(cfg.taxAccount);
  await page.getByTestId('wallet-add').click();
  await settle(page);
  await expect(page.getByTestId('wallets')).toContainText(`${cfg.taxAccount.slice(0, 6)}…${cfg.taxAccount.slice(-4)}`);
  await expect(page.getByTestId('wallet-payments')).toBeVisible();

  // Moving to Portugal from today: a new vault with Portugal's rules, and the same payment address
  // moves to it after the notice (the passkey signs). The Spanish vault stays, with its reserve.
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByTestId('change-country').click();
  await page.getByTestId('move-country').selectOption('pt');
  await expect(page.getByTestId('move-plan')).toContainText('Lo que vas a firmar');
  await page.getByTestId('move-sign').click();
  await settle(page);
  await expect(page.getByTestId('move-card')).toContainText('firmado');
  try {
    await expect(page.locator('header.greet')).toContainText('Portugal', { timeout: 300_000 });
  } catch (e) {
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kyros.vault.')).map((k) => JSON.stringify(JSON.parse(localStorage.getItem(k) ?? '{}').move ?? null)));
    throw new Error(`${(e as Error).message.slice(0, 300)}\n[move log] ${moveLog.slice(-4).join(' | ')}\n[stored move] ${stored.join(' ')}\n${consoleErrors.slice(-3).join('\n')}`);
  }
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await expect(page.getByTestId('previous-vaults')).toContainText('España');
  await page.getByTestId('previous-vaults').getByRole('button', { name: 'Abrir' }).click();
  await expect(page.getByTestId('archived-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a la actual' }).click();
  await expect(page.locator('header.greet')).toContainText('Portugal');
});

test('Argentina: the monotributo can be chosen in onboarding, and its plan charges no IVA', async ({ page }) => {
  await virtualFaceId(page);
  await page.goto('./');
  await page.getByTestId('create-passkey').click();
  await settle(page);
  await page.getByLabel('País').selectOption('ar');
  await page.getByTestId('next-1').click();
  await page.getByTestId('activity-software').click();
  await page.getByTestId('next-2').click();
  await page.getByTestId('client-business-local').click();
  await page.getByTestId('regime-monotributo').click();
  await page.getByTestId('next-3').click();
  await expect(page.getByText('Tu plan está listo')).toBeVisible();
  await expect(page.locator('.content')).toContainText('Sin IVA');
});

test('the user picks the language and it is remembered', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('lang')).toHaveValue('es');
  await page.getByTestId('lang').selectOption('en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set your taxes aside the moment you get paid.');
  await page.reload();
  await expect(page.getByTestId('lang')).toHaveValue('en');
  await expect(page.getByTestId('create-passkey')).toHaveText('Create my account with Face ID');
});

test('a client can pay a payment link from another chain with an EVM wallet', async ({ page }) => {
  // A wallet that announces itself the way MetaMask, Rabby or Phantom do (EIP-6963).
  await page.addInitScript(() => {
    const provider = { request: async () => [] };
    window.addEventListener('eip6963:requestProvider', () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '1', name: 'Test Wallet', icon: '', rdns: 'test.wallet' }, provider } })),
    );
  });
  const cfg = await (await page.request.get('./testnet.json')).json();
  test.skip(!cfg.cctp, 'this testnet deployment predates cross-chain payments');
  await page.goto(`./#pagar?v=${cfg.router}&r=${'00'.repeat(32)}&a=12100000000`);
  await expect(page.getByTestId('cross-chain')).toBeVisible();
  await expect(page.locator('#evm-chain option')).toHaveCount(5);
  await page.getByTestId('find-evm-wallets').click();
  await expect(page.getByText('Pagar con Test Wallet')).toBeVisible();
  // Circle's attestation service answers this page (CORS), so the browser can finish the payment itself.
  const status = await page.evaluate(async () => (await fetch('https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/27')).status);
  expect(status).toBe(200);
});
