/** The two things the app needs from Shopify: trusting its webhooks, and marking an order paid. */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Whether a webhook body was signed by Shopify with the app's secret (`X-Shopify-Hmac-Sha256`). */
export function verifyWebhook(rawBody: Buffer | string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const want = createHmac('sha256', secret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(hmacHeader, 'base64');
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface AdminApi {
  shop: string;
  token: string;
  /** Admin API version, e.g. 2025-10. */
  version?: string;
  fetch?: typeof fetch;
}

async function graphql<T>(api: AdminApi, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await (api.fetch ?? fetch)(`https://${api.shop}/admin/api/${api.version ?? '2025-10'}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': api.token },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await r.json()) as { data?: T; errors?: unknown };
  if (!r.ok || j.errors || !j.data) throw new Error(`Shopify Admin API: HTTP ${r.status} ${JSON.stringify(j.errors ?? '')}`);
  return j.data;
}

/**
 * Marks the order paid (it was placed with a manual payment method), and
 * keeps the Stellar transactions on it: a metafield and a tag.
 */
export async function markPaid(api: AdminApi, orderGid: string, transactions: string[]): Promise<void> {
  const paid = await graphql<{ orderMarkAsPaid: { userErrors: { message: string }[] } }>(
    api,
    `mutation kyrosPaid($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id } userErrors { field message } } }`,
    { input: { id: orderGid } },
  );
  const errors = paid.orderMarkAsPaid.userErrors;
  if (errors.length) throw new Error(`orderMarkAsPaid: ${errors.map((e) => e.message).join('; ')}`);
  await graphql(
    api,
    `mutation kyrosNote($metafields: [MetafieldsSetInput!]!, $id: ID!, $tags: [String!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
      tagsAdd(id: $id, tags: $tags) { userErrors { message } }
    }`,
    { metafields: [{ ownerId: orderGid, namespace: 'kyros', key: 'transactions', type: 'json', value: JSON.stringify(transactions) }], id: orderGid, tags: ['kyros-paid'] },
  );
}
