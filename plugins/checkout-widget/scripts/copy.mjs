// The WooCommerce plugin ships the built widget.
import { copyFileSync } from 'node:fs';
copyFileSync('dist/kyros-checkout.js', '../woocommerce/kyros-checkout/assets/kyros-checkout.js');
console.log('copied to ../woocommerce/kyros-checkout/assets/kyros-checkout.js');
