/**
 * Invoices that a Kyros vault splits exactly.
 *
 * One invoice model, four outputs:
 *   - `toUbl`: an EN 16931 invoice in UBL 2.1 (Peppol BIS Billing 3.0), the
 *     format the EU's ViDA package builds on and that Spain's B2B
 *     e-invoicing accepts. For invoices without withholding.
 *   - `toFacturae`: Facturae 3.2.2 (unsigned), the Spanish format, which also
 *     carries the IRPF a business client withholds.
 *   - `verifactuAlta` / `verifactuQrUrl`: the chained record and the QR a
 *     VERI*FACTU billing system must produce in Spain.
 *   - `vaultTerms`: what to register in the vault (`expect_invoice`) so the
 *     payment carrying the invoice's reference splits exactly: its VAT, the
 *     IRPF the client withheld, and the reserve on top.
 *
 * Money is handled in exact decimals (cents, bigint); nothing goes through
 * floating point.
 */
import { createHash } from 'node:crypto';
import { BPS, type Bucket } from './split.js';

export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'O';

export interface Party {
  name: string;
  /** Tax id. In UBL it is written as given (an EU VAT number carries its country prefix, e.g. ESB12345678). */
  taxId: string;
  /** ISO 3166-1 alpha-2, e.g. ES. */
  country: string;
  street?: string;
  city?: string;
  postalCode?: string;
  province?: string;
  /** For Facturae: an individual (F) or a company (J). Defaults to J. */
  person?: 'F' | 'J';
  /** For Facturae, individuals: first surname (and the name in `name`). */
  surname?: string;
  email?: string;
}

export interface InvoiceLine {
  description: string;
  /** Decimal string, e.g. "1" or "2.5". */
  quantity: string;
  /** Net unit price, decimal string with up to 6 decimals. */
  unitPrice: string;
  /** VAT category (EN 16931): S standard/reduced, Z zero, E exempt, AE reverse charge, O outside the scope. */
  vat: { category: VatCategory; rate: string; exemptionReason?: string };
  /** UN/ECE unit code for UBL (default C62, "one"). */
  unitCode?: string;
}

export interface Invoice {
  series?: string;
  number: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  dueDate?: string;
  currency: string;
  seller: Party;
  buyer: Party;
  lines: InvoiceLine[];
  /** Income tax the client withholds, as a percent of the base (Spanish IRPF on professional invoices, e.g. "15"). */
  withholding?: { rate: string; label?: string };
  /** Free text, e.g. why VAT is not charged. */
  note?: string;
  /** Buyer reference (Peppol needs it or an order reference); defaults to the invoice number. */
  buyerReference?: string;
  /** Where to pay: a Kyros inbox or vault address and the token. */
  payment?: { address: string; asset: string; issuer?: string };
}

// ---- exact decimals ----

/** Parses a non-negative decimal string into an integer scaled by 10^scale. */
function dec(s: string, scale: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = m[2] ?? '';
  if (frac.length > scale) throw new Error(`more than ${scale} decimals: ${s}`);
  return BigInt(m[1]) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0') || '0');
}

/** Divides and rounds half away from zero (amounts here are never negative). */
function divRound(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

/** Cents to "1234.50". */
export function money(cents: bigint): string {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  return `${neg ? '-' : ''}${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
}

/** A rate written as the codes want it: "21" stays "21", "10.50" -> "10.5". */
function rateText(rate: string): string {
  const v = dec(rate, 2);
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export interface Totals {
  /** Net amount of each line, in cents. */
  lines: bigint[];
  /** One group per VAT category and rate. */
  vat: { category: VatCategory; rate: string; taxable: bigint; tax: bigint; exemptionReason?: string }[];
  net: bigint;
  tax: bigint;
  /** net + tax: the invoice total. */
  gross: bigint;
  withheld: bigint;
  /** gross - withheld: what the client pays. */
  payable: bigint;
}

/**
 * The totals EN 16931 prescribes: line net = quantity x price rounded to
 * cents; VAT per category and rate = taxable x rate rounded to cents.
 */
export function invoiceTotals(inv: Invoice): Totals {
  if (!inv.lines.length) throw new Error('an invoice needs at least one line');
  const lines = inv.lines.map((l) => divRound(dec(l.quantity, 4) * dec(l.unitPrice, 6), 10n ** 8n));
  const groups = new Map<string, Totals['vat'][number]>();
  inv.lines.forEach((l, i) => {
    const zeroRated = l.vat.category !== 'S';
    if (zeroRated && dec(l.vat.rate, 2) !== 0n) throw new Error(`category ${l.vat.category} takes a 0% rate`);
    if (zeroRated && l.vat.category !== 'Z' && !l.vat.exemptionReason && !inv.note) {
      throw new Error(`category ${l.vat.category} needs an exemption reason (e.g. "Inversión del sujeto pasivo")`);
    }
    const key = `${l.vat.category}/${rateText(l.vat.rate)}`;
    const g = groups.get(key) ?? { category: l.vat.category, rate: rateText(l.vat.rate), taxable: 0n, tax: 0n, exemptionReason: l.vat.exemptionReason };
    g.taxable += lines[i];
    groups.set(key, g);
  });
  const vat = [...groups.values()].map((g) => ({ ...g, tax: divRound(g.taxable * dec(g.rate, 2), 10_000n) }));
  const net = lines.reduce((a, b) => a + b, 0n);
  const tax = vat.reduce((a, g) => a + g.tax, 0n);
  const withheld = inv.withholding ? divRound(net * dec(inv.withholding.rate, 2), 10_000n) : 0n;
  return { lines, vat, net, tax, gross: net + tax, withheld, payable: net + tax - withheld };
}

/** The invoice number as printed: series and number together, e.g. "2026A-0042". */
export function invoiceId(inv: Invoice): string {
  return `${inv.series ?? ''}${inv.number}`;
}

/** The 32-byte reference a payment carries: sha256 of the invoice id (only the hash goes onchain). */
export function invoiceRef(inv: Invoice): Uint8Array {
  return createHash('sha256').update(invoiceId(inv), 'utf8').digest();
}

/**
 * The terms to register in the vault for this invoice (`expect_invoice`):
 * its VAT (several rates are blended into one), the client's withholding,
 * and `buckets`, the reserve on top of what the client withholds (e.g. a 20%
 * income-tax reserve becomes 5% when the client already withholds 15%).
 */
export function vaultTerms(inv: Invoice, buckets: Bucket[]): { vatBps: number; withholdingBps: number; buckets: Bucket[] } {
  const t = invoiceTotals(inv);
  const vatBps = t.net === 0n ? 0 : Number(divRound(t.tax * BPS, t.net));
  const withholdingBps = inv.withholding ? Number(dec(inv.withholding.rate, 2)) : 0;
  return { vatBps, withholdingBps, buckets };
}

/** The payable amount in a 7-decimal Stellar token, for an invoice paid 1:1 in its currency's stablecoin (EUR in EURC). */
export function payableUnits(inv: Invoice): bigint {
  return invoiceTotals(inv).payable * 100_000n;
}

// ---- XML ----

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Node = [string, Record<string, string> | null, ...(Node | string | null | undefined | false)[]];

function render(n: Node, depth = 0): string {
  const [tag, attrs, ...kids] = n;
  const pad = '  '.repeat(depth);
  const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
  const present = kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false);
  if (!present.length) return `${pad}<${tag}${a}/>`;
  if (present.length === 1 && typeof present[0] === 'string') return `${pad}<${tag}${a}>${esc(present[0])}</${tag}>`;
  return `${pad}<${tag}${a}>\n${present.map((k) => (typeof k === 'string' ? `${pad}  ${esc(k)}` : render(k, depth + 1))).join('\n')}\n${pad}</${tag}>`;
}

const el = (tag: string, ...kids: (Node | string | null | undefined | false)[]): Node => [tag, null, ...kids];
const at = (tag: string, attrs: Record<string, string>, ...kids: (Node | string | null | undefined | false)[]): Node => [tag, attrs, ...kids];

// ---- UBL 2.1 / Peppol BIS Billing 3.0 ----

/** Peppol participant scheme for a tax id: Spain's NIF (9920) or a generic VAT number (EAS code per country, simplified). */
function endpointScheme(p: Party): string {
  return p.country === 'ES' ? '9920' : '9930';
}

function ublParty(p: Party): Node {
  return el(
    'cac:Party',
    at('cbc:EndpointID', { schemeID: endpointScheme(p) }, p.taxId),
    el('cac:PartyName', el('cbc:Name', p.name)),
    el(
      'cac:PostalAddress',
      p.street ? el('cbc:StreetName', p.street) : null,
      p.city ? el('cbc:CityName', p.city) : null,
      p.postalCode ? el('cbc:PostalZone', p.postalCode) : null,
      p.province ? el('cbc:CountrySubentity', p.province) : null,
      el('cac:Country', el('cbc:IdentificationCode', p.country)),
    ),
    el('cac:PartyTaxScheme', el('cbc:CompanyID', p.taxId), el('cac:TaxScheme', el('cbc:ID', 'VAT'))),
    el('cac:PartyLegalEntity', el('cbc:RegistrationName', p.name)),
    p.email ? el('cac:Contact', el('cbc:ElectronicMail', p.email)) : null,
  );
}

/**
 * The invoice in UBL 2.1 following Peppol BIS Billing 3.0 (EN 16931). The
 * Stellar payment goes in PaymentMeans (code ZZZ, mutually defined) with the
 * invoice id as payment reference. Invoices with withholding are refused:
 * EN 16931 has no withholding, so use `toFacturae` for those.
 */
export function toUbl(inv: Invoice): string {
  if (inv.withholding) throw new Error('EN 16931 cannot carry a withholding: issue this invoice as Facturae (toFacturae)');
  const t = invoiceTotals(inv);
  const cur = inv.currency;
  const amt = (tag: string, cents: bigint) => at(tag, { currencyID: cur }, money(cents));
  const taxCategory = (tag: string, category: VatCategory, rate: string, reason?: string) =>
    el(
      tag,
      el('cbc:ID', category),
      el('cbc:Percent', rateText(rate)),
      tag === 'cac:TaxCategory' && reason ? el('cbc:TaxExemptionReason', reason) : null,
      el('cac:TaxScheme', el('cbc:ID', 'VAT')),
    );
  const doc = at(
    'Invoice',
    {
      xmlns: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
      'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
      'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    },
    el('cbc:CustomizationID', 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0'),
    el('cbc:ProfileID', 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'),
    el('cbc:ID', invoiceId(inv)),
    el('cbc:IssueDate', inv.issueDate),
    inv.dueDate ? el('cbc:DueDate', inv.dueDate) : null,
    el('cbc:InvoiceTypeCode', '380'),
    inv.note ? el('cbc:Note', inv.note) : null,
    el('cbc:DocumentCurrencyCode', cur),
    el('cbc:BuyerReference', inv.buyerReference ?? invoiceId(inv)),
    el('cac:AccountingSupplierParty', ublParty(inv.seller)),
    el('cac:AccountingCustomerParty', ublParty(inv.buyer)),
    inv.payment
      ? el(
          'cac:PaymentMeans',
          at('cbc:PaymentMeansCode', { name: 'Stellar stablecoin transfer' }, 'ZZZ'),
          el('cbc:PaymentID', invoiceId(inv)),
          el('cac:PayeeFinancialAccount', el('cbc:ID', inv.payment.address), el('cbc:Name', `${inv.payment.asset} on Stellar`)),
        )
      : null,
    el(
      'cac:TaxTotal',
      amt('cbc:TaxAmount', t.tax),
      ...t.vat.map((g) => el('cac:TaxSubtotal', amt('cbc:TaxableAmount', g.taxable), amt('cbc:TaxAmount', g.tax), taxCategory('cac:TaxCategory', g.category, g.rate, g.exemptionReason ?? (g.category !== 'S' && g.category !== 'Z' ? inv.note : undefined)))),
    ),
    el(
      'cac:LegalMonetaryTotal',
      amt('cbc:LineExtensionAmount', t.net),
      amt('cbc:TaxExclusiveAmount', t.net),
      amt('cbc:TaxInclusiveAmount', t.gross),
      amt('cbc:PayableAmount', t.payable),
    ),
    ...inv.lines.map((l, i) =>
      el(
        'cac:InvoiceLine',
        el('cbc:ID', String(i + 1)),
        at('cbc:InvoicedQuantity', { unitCode: l.unitCode ?? 'C62' }, l.quantity),
        amt('cbc:LineExtensionAmount', t.lines[i]),
        el('cac:Item', el('cbc:Name', l.description), taxCategory('cac:ClassifiedTaxCategory', l.vat.category, l.vat.rate)),
        el('cac:Price', at('cbc:PriceAmount', { currencyID: cur }, l.unitPrice)),
      ),
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(doc)}\n`;
}

// ---- Facturae 3.2.2 ----

const ISO3: Record<string, string> = {
  ES: 'ESP', PT: 'PRT', FR: 'FRA', DE: 'DEU', IT: 'ITA', NL: 'NLD', BE: 'BEL', IE: 'IRL', LU: 'LUX', AT: 'AUT', GB: 'GBR', US: 'USA', CH: 'CHE',
  AD: 'AND', MC: 'MCO', MX: 'MEX', AR: 'ARG', CO: 'COL', EE: 'EST', MT: 'MLT', CY: 'CYP', AE: 'ARE', SG: 'SGP', PL: 'POL', SE: 'SWE', DK: 'DNK', FI: 'FIN',
};

function residence(p: Party): 'R' | 'U' | 'E' {
  const eu = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'GR', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
  return p.country === 'ES' ? 'R' : eu.has(p.country) ? 'U' : 'E';
}

function facturaeParty(tag: string, p: Party): Node {
  const iso3 = ISO3[p.country];
  if (!iso3) throw new Error(`no ISO 3166 alpha-3 code for ${p.country}`);
  const address =
    p.country === 'ES'
      ? el('AddressInSpain', el('Address', p.street ?? ''), el('PostCode', p.postalCode ?? ''), el('Town', p.city ?? ''), el('Province', p.province ?? ''), el('CountryCode', iso3))
      : el('OverseasAddress', el('Address', p.street ?? ''), el('PostCodeAndTown', `${p.postalCode ?? ''} ${p.city ?? ''}`.trim()), el('Province', p.province ?? p.city ?? ''), el('CountryCode', iso3));
  const person = p.person ?? 'J';
  return el(
    tag,
    el('TaxIdentification', el('PersonTypeCode', person), el('ResidenceTypeCode', residence(p)), el('TaxIdentificationNumber', p.taxId)),
    person === 'J' ? el('LegalEntity', el('CorporateName', p.name), address) : el('Individual', el('Name', p.name), el('FirstSurname', p.surname ?? ''), address),
  );
}

/** Facturae: amounts with two decimals; tax rates as "21.00". */
const rate2 = (r: string) => money(dec(r, 2));

/**
 * The invoice as Facturae 3.2.2, unsigned (a signature is needed only for
 * the public sector's FACe; Spanish B2B e-invoicing accepts it as is). VAT
 * is tax type 01 and the client's IRPF withholding tax type 04.
 */
export function toFacturae(inv: Invoice): string {
  const t = invoiceTotals(inv);
  const m = (cents: bigint) => money(cents);
  const tax = (code: string, rate: string, base: bigint, amount: bigint) =>
    el('Tax', el('TaxTypeCode', code), el('TaxRate', rate2(rate)), el('TaxableBase', el('TotalAmount', m(base))), el('TaxAmount', el('TotalAmount', m(amount))));
  const withheldOn = (base: bigint) => (inv.withholding ? divRound(base * dec(inv.withholding.rate, 2), 10_000n) : 0n);
  const lines = inv.lines.map((l, i) => {
    const net = t.lines[i];
    const vatAmount = divRound(net * dec(l.vat.rate, 2), 10_000n);
    return el(
      'InvoiceLine',
      el('ItemDescription', l.description),
      el('Quantity', l.quantity),
      el('UnitOfMeasure', '01'),
      el('UnitPriceWithoutTax', l.unitPrice),
      el('TotalCost', m(net)),
      el('GrossAmount', m(net)),
      inv.withholding ? el('TaxesWithheld', tax('04', inv.withholding.rate, net, withheldOn(net))) : null,
      el('TaxesOutputs', tax('01', l.vat.rate, net, vatAmount)),
    );
  });
  const payment = inv.payment
    ? el(
        'PaymentDetails',
        el(
          'Installment',
          el('InstallmentDueDate', inv.dueDate ?? inv.issueDate),
          el('InstallmentAmount', m(t.payable)),
          el('PaymentMeans', '13'),
          el('PaymentReconciliationReference', invoiceId(inv).slice(0, 60)),
          el('CollectionAdditionalInformation', `Pago en ${inv.payment.asset} (Stellar) a ${inv.payment.address}, con la referencia de esta factura.`),
        ),
      )
    : null;
  const doc = at(
    'fe:Facturae',
    { 'xmlns:fe': 'http://www.facturae.gob.es/formato/Versiones/Facturaev3_2_2.xml', 'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#' },
    el(
      'FileHeader',
      el('SchemaVersion', '3.2.2'),
      el('Modality', 'I'),
      el('InvoiceIssuerType', 'EM'),
      el(
        'Batch',
        el('BatchIdentifier', `${inv.seller.taxId}${invoiceId(inv)}`.slice(0, 70)),
        el('InvoicesCount', '1'),
        el('TotalInvoicesAmount', el('TotalAmount', m(t.payable))),
        el('TotalOutstandingAmount', el('TotalAmount', m(t.payable))),
        el('TotalExecutableAmount', el('TotalAmount', m(t.payable))),
        el('InvoiceCurrencyCode', inv.currency),
      ),
    ),
    el('Parties', facturaeParty('SellerParty', inv.seller), facturaeParty('BuyerParty', inv.buyer)),
    el(
      'Invoices',
      el(
        'Invoice',
        el('InvoiceHeader', el('InvoiceNumber', inv.number), inv.series ? el('InvoiceSeriesCode', inv.series) : null, el('InvoiceDocumentType', 'FC'), el('InvoiceClass', 'OO')),
        el('InvoiceIssueData', el('IssueDate', inv.issueDate), el('InvoiceCurrencyCode', inv.currency), el('TaxCurrencyCode', inv.currency), el('LanguageName', 'es')),
        el('TaxesOutputs', ...t.vat.map((g) => tax('01', g.rate, g.taxable, g.tax))),
        inv.withholding ? el('TaxesWithheld', tax('04', inv.withholding.rate, t.net, t.withheld)) : null,
        el(
          'InvoiceTotals',
          el('TotalGrossAmount', m(t.net)),
          el('TotalGrossAmountBeforeTaxes', m(t.net)),
          el('TotalTaxOutputs', m(t.tax)),
          el('TotalTaxesWithheld', m(t.withheld)),
          el('InvoiceTotal', m(t.payable)),
          el('TotalOutstandingAmount', m(t.payable)),
          el('TotalExecutableAmount', m(t.payable)),
        ),
        el('Items', ...lines),
        payment,
        inv.note ? el('AdditionalData', el('InvoiceAdditionalInformation', inv.note)) : null,
      ),
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(doc)}\n`;
}

// ---- VERI*FACTU (Spain) ----

export interface VerifactuAlta {
  IDEmisorFactura: string;
  NumSerieFactura: string;
  /** DD-MM-YYYY. */
  FechaExpedicionFactura: string;
  /** F1 complete invoice, F2 simplified. */
  TipoFactura: 'F1' | 'F2';
  CuotaTotal: string;
  /** Base plus VAT (the client's IRPF withholding is not subtracted). */
  ImporteTotal: string;
  /** The previous record's hash; empty for the first record of the system. */
  HuellaAnterior: string;
  /** ISO 8601 with offset, e.g. 2026-10-17T10:30:00+02:00. */
  FechaHoraHusoGenRegistro: string;
  /** SHA-256 (uppercase hex) of the chained fields. */
  Huella: string;
}

const ddmmyyyy = (iso: string) => {
  const [y, mo, d] = iso.split('-');
  return `${d}-${mo}-${y}`;
};

/** `date` as ISO 8601 with the offset of `timeZone` (AEAT rejects the `Z` form). */
export function isoWithOffset(date: Date, timeZone = 'Europe/Madrid'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

/**
 * The hash (huella) of a registration record: SHA-256, uppercase hex, over
 * `IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=…&TipoFactura=…&CuotaTotal=…&ImporteTotal=…&Huella=<previous>&FechaHoraHusoGenRegistro=…`,
 * values unescaped, the previous hash empty for the first record.
 */
export function verifactuHash(r: Omit<VerifactuAlta, 'Huella'>): string {
  const chain =
    `IDEmisorFactura=${r.IDEmisorFactura}&NumSerieFactura=${r.NumSerieFactura}&FechaExpedicionFactura=${r.FechaExpedicionFactura}` +
    `&TipoFactura=${r.TipoFactura}&CuotaTotal=${r.CuotaTotal}&ImporteTotal=${r.ImporteTotal}&Huella=${r.HuellaAnterior}` +
    `&FechaHoraHusoGenRegistro=${r.FechaHoraHusoGenRegistro}`;
  return createHash('sha256').update(chain, 'utf8').digest('hex').toUpperCase();
}

/**
 * The VERI*FACTU registration record of an invoice, chained to the previous
 * record by its hash. Submitting it to the AEAT needs the issuer's
 * certificate and is not done here.
 */
export function verifactuAlta(
  inv: Invoice,
  previousHash: string,
  generatedAt: Date,
  o: { type?: 'F1' | 'F2'; timeZone?: string } = {},
): VerifactuAlta {
  if (inv.seller.country !== 'ES') throw new Error('VERI*FACTU applies to Spanish issuers');
  const t = invoiceTotals(inv);
  const r = {
    IDEmisorFactura: inv.seller.taxId.replace(/^ES/, ''),
    NumSerieFactura: invoiceId(inv),
    FechaExpedicionFactura: ddmmyyyy(inv.issueDate),
    TipoFactura: o.type ?? 'F1',
    CuotaTotal: money(t.tax),
    ImporteTotal: money(t.gross),
    HuellaAnterior: previousHash,
    FechaHoraHusoGenRegistro: isoWithOffset(generatedAt, o.timeZone ?? 'Europe/Madrid'),
  };
  return { ...r, Huella: verifactuHash(r) };
}

/**
 * The URL in the invoice's QR code, which anyone can open to check the
 * invoice with the AEAT. `test` uses the AEAT's pre-production host.
 */
export function verifactuQrUrl(r: Pick<VerifactuAlta, 'IDEmisorFactura' | 'NumSerieFactura' | 'FechaExpedicionFactura' | 'ImporteTotal'>, o: { test?: boolean } = {}): string {
  const host = o.test ? 'https://prewww2.aeat.es' : 'https://www2.agenciatributaria.gob.es';
  const q = new URLSearchParams({ nif: r.IDEmisorFactura, numserie: r.NumSerieFactura, fecha: r.FechaExpedicionFactura, importe: r.ImporteTotal });
  return `${host}/wlpl/TIKE-CONT/ValidarQR?${q.toString()}`;
}
