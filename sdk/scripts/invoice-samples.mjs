// Writes sample invoices from the SDK (after `npm run build`) for the format
// validators: node scripts/invoice-samples.mjs <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toUbl, toFacturae } from '../dist/invoice.js';

const out = process.argv[2] ?? 'invoice-samples';
mkdirSync(out, { recursive: true });

const seller = { name: 'Lucía Martín', surname: 'Martín', person: 'F', taxId: '12345678Z', country: 'ES', street: 'Calle Mayor 1', city: 'Madrid', postalCode: '28013', province: 'Madrid', email: 'lucia@example.com' };
const buyerEs = { name: 'Acme Software SL', taxId: 'B12345674', country: 'ES', street: 'Gran Vía 2', city: 'Valencia', postalCode: '46002', province: 'Valencia' };
const buyerDe = { name: 'Beispiel GmbH', taxId: 'DE123456789', country: 'DE', street: 'Hauptstr. 3', city: 'Berlin', postalCode: '10115' };
const pay = { address: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K', asset: 'EURC' };

const spanishClient = {
  series: '2026A-', number: '0042', issueDate: '2026-10-17', dueDate: '2026-11-16', currency: 'EUR',
  seller: { ...seller, taxId: 'ES12345678Z' }, buyer: { ...buyerEs, taxId: 'ESB12345674' }, payment: pay,
  lines: [
    { description: 'Desarrollo de smart contracts (octubre)', quantity: '1', unitPrice: '1000', vat: { category: 'S', rate: '21' } },
    { description: 'Horas de soporte', quantity: '2.5', unitPrice: '40', vat: { category: 'S', rate: '21' } },
  ],
};
writeFileSync(join(out, 'ubl-es-b2b.xml'), toUbl(spanishClient));

const euClient = {
  number: '0043', issueDate: '2026-10-17', currency: 'EUR', seller: { ...seller, taxId: 'ES12345678Z' }, buyer: buyerDe, payment: pay,
  note: 'Inversión del sujeto pasivo (art. 196 Directiva 2006/112/CE)',
  lines: [{ description: 'Smart contract audit', quantity: '1', unitPrice: '2500', vat: { category: 'AE', rate: '0', exemptionReason: 'Reverse charge' } }],
};
writeFileSync(join(out, 'ubl-eu-reverse-charge.xml'), toUbl(euClient));

const withIrpf = {
  number: '0044', series: '2026A-', issueDate: '2026-10-17', dueDate: '2026-11-16', currency: 'EUR', seller, buyer: buyerEs, payment: pay,
  withholding: { rate: '15' },
  lines: [{ description: 'Consultoría', quantity: '1', unitPrice: '1000', vat: { category: 'S', rate: '21' } }],
};
writeFileSync(join(out, 'facturae-irpf.xml'), toFacturae(withIrpf));
writeFileSync(join(out, 'facturae-eu.xml'), toFacturae({ ...euClient, seller }));
console.log(`samples in ${out}`);
