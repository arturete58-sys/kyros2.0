<?php
/**
 * Kyros in the block checkout (the default checkout of new WooCommerce stores).
 * The buyer picks Kyros, places the order, and pays on the order's payment page.
 */

if (!defined('ABSPATH')) {
	exit;
}

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class Kyros_Blocks extends AbstractPaymentMethodType {
	protected $name = 'kyros';

	public function initialize() {
		$this->settings = get_option('woocommerce_kyros_settings', []);
	}

	public function is_active() {
		$gateways = WC()->payment_gateways()->payment_gateways();
		return isset($gateways['kyros']) && $gateways['kyros']->is_available();
	}

	public function get_payment_method_script_handles() {
		wp_register_script('kyros-blocks', plugins_url('../assets/kyros-blocks.js', __FILE__), ['wc-blocks-registry', 'wp-element', 'wp-html-entities'], KYROS_CHECKOUT_VERSION, true);
		return ['kyros-blocks'];
	}

	public function get_payment_method_data() {
		return [
			'title' => $this->settings['title'] ?? 'Pay with USDC on Stellar',
			'description' => $this->settings['description'] ?? '',
		];
	}
}
