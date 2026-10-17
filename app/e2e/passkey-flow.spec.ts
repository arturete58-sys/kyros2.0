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

async function settle(page: Page) {
  await expect(page.getByTestId('busy')).toHaveCount(0, { timeout: 300_000 });
  const err = page.getByTestId('error');
  // The browser's errors go into the message, so CI shows them in the run's annotations.
  if (await err.count()) throw new Error(`app error: ${await err.textContent()}\n${consoleErrors.slice(-5).join('\n')}`);
}

const amountOf = async (page: Page, testid: string) => Number(((await page.getByTestId(testid).locator('.big, .amount').first().textContent()) ?? '0').replace(/[^\d,]/g, '').replace(',', '.'));

test('a freelancer signs up with a passkey, gets paid, registers an expected payment and pays the tax', async ({ page }) => {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 1500)));
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
