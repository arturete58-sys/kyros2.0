// The WooCommerce plugin and the Shopify server ship the built widget.
import { copyFileSync } from 'node:fs';
for (const to of ['../woocommerce/kyros-checkout/assets/kyros-checkout.js', '../shopify/public/kyros-checkout.js']) {
  copyFileSync('dist/kyros-checkout.js', to);
  console.log(`copied to ${to}`);
}
