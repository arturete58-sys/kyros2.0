// The extension's API for its target (what the Shopify CLI generates).
import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ThankYou.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
