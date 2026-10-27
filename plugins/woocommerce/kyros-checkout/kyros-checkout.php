<?php
/**
 * Plugin Name: Kyros Checkout for WooCommerce
 * Plugin URI: https://github.com/arturete58-sys/kyros2.0/tree/main/plugins/woocommerce
 * Description: Customers pay in stablecoins on Stellar from any wallet. Each payment lands in your Kyros vault, which sets the VAT and your income-tax reserve aside on arrival. No custody: the plugin holds no keys.
 * Version: 0.1.0
 * Requires at least: 6.3
 * Requires PHP: 8.0
 * WC requires at least: 8.0
 * Author: Kyros
 * License: Apache-2.0
 * Text Domain: kyros-checkout
 */

if (!defined('ABSPATH')) {
	exit;
}

require_once __DIR__ . '/includes/class-kyros-core.php';

const KYROS_CHECKOUT_VERSION = '0.1.0';

// Orders in custom tables (HPOS) and the block checkout are supported.
add_action('before_woocommerce_init', function () {
	if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
	}
});

add_action('plugins_loaded', function () {
	if (!class_exists('WC_Payment_Gateway')) {
		return;
	}

	final class WC_Gateway_Kyros extends WC_Payment_Gateway {
		public function __construct() {
			$this->id = 'kyros';
			$this->method_title = 'Kyros (stablecoins on Stellar)';
			$this->method_description = __('Customers pay in USDC or EURC on Stellar from any wallet. One transfer per VAT rate goes to your Kyros payment address for that rate, and your vault sets the VAT and income-tax reserve aside on arrival. Paste the configuration from the Kyros app (Settings → Sell online).', 'kyros-checkout');
			$this->has_fields = false;
			$this->supports = ['products'];
			$this->init_form_fields();
			$this->init_settings();
			$this->title = $this->get_option('title');
			$this->description = $this->get_option('description');
			add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
			add_action('woocommerce_receipt_' . $this->id, [$this, 'receipt_page']);
		}

		public function init_form_fields() {
			$this->form_fields = [
				'enabled' => ['title' => __('Enable', 'kyros-checkout'), 'type' => 'checkbox', 'label' => __('Accept stablecoins on Stellar with Kyros', 'kyros-checkout'), 'default' => 'no'],
				'title' => ['title' => __('Title', 'kyros-checkout'), 'type' => 'text', 'default' => __('Pay with USDC on Stellar', 'kyros-checkout')],
				'description' => ['title' => __('Description', 'kyros-checkout'), 'type' => 'textarea', 'default' => __('Pay from LOBSTR, Freighter, xBull or any Stellar wallet.', 'kyros-checkout')],
				'config' => ['title' => __('Kyros configuration', 'kyros-checkout'), 'type' => 'textarea', 'description' => __('The JSON the Kyros app gives you in Settings → Sell online: network, asset and one payment address per VAT rate.', 'kyros-checkout'), 'default' => ''],
				'horizon' => ['title' => __('Horizon URL', 'kyros-checkout'), 'type' => 'text', 'description' => __('Used to check payments on chain. Empty: the public Horizon of the network.', 'kyros-checkout'), 'default' => ''],
				'rpc' => ['title' => __('Stellar RPC URL', 'kyros-checkout'), 'type' => 'text', 'description' => __('Used by the buyer’s browser to prepare the transfer. Required on mainnet (your RPC provider).', 'kyros-checkout'), 'default' => ''],
			];
		}

		/** @return array|null The parsed configuration, or null if it is missing or invalid. */
		public function config() {
			try {
				return Kyros_Core::config((string) $this->get_option('config'));
			} catch (Throwable $e) {
				return null;
			}
		}

		public function horizon(array $c): string {
			$h = trim((string) $this->get_option('horizon'));
			return $h !== '' ? $h : ($c['network'] === 'pubnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org');
		}

		/** Shown only when it is configured and the store's currency is the stablecoin's. */
		public function is_available() {
			$c = $this->config();
			if (!$c || !parent::is_available()) {
				return false;
			}
			$want = in_array(strtoupper($c['asset']['code']), ['EURC', 'KEUR'], true) ? 'EUR' : 'USD';
			return get_woocommerce_currency() === $want;
		}

		public function process_admin_options() {
			$saved = parent::process_admin_options();
			if ((string) $this->get_option('config') !== '' && !$this->config()) {
				WC_Admin_Settings::add_error(__('Kyros: the configuration is not valid. Copy it again from the Kyros app.', 'kyros-checkout'));
			}
			return $saved;
		}

		public function process_payment($order_id) {
			$order = wc_get_order($order_id);
			$order->update_status('pending', __('Waiting for the payment on Stellar.', 'kyros-checkout'));
			return ['result' => 'success', 'redirect' => $order->get_checkout_payment_url(true)];
		}

		/**
		 * The transfers for an order: its lines grouped by VAT rate. Saved with the order the
		 * first time, so a later change of settings does not change what the buyer was asked.
		 */
		public static function payments_for(WC_Order $order, array $c): array {
			$saved = $order->get_meta('_kyros_payments');
			if ($saved) {
				return json_decode($saved, true);
			}
			$units = fn($x) => Kyros_Core::units(wc_format_decimal(max(0, (float) $x), Kyros_Core::DECIMALS));
			$lines = [];
			foreach ($order->get_items(['line_item', 'shipping', 'fee']) as $item) {
				$taxes = $item->get_taxes()['total'] ?? [];
				$bps = 0;
				$vat = 0.0;
				foreach ($taxes as $rate_id => $amount) {
					if ($amount === '' || (float) $amount === 0.0) {
						continue;
					}
					$bps += Kyros_Core::bps(WC_Tax::get_rate_percent_value($rate_id));
					$vat += (float) $amount;
				}
				$lines[] = ['net' => $units($item->get_total()), 'vat' => $units($vat), 'bps' => $bps];
			}
			$r = Kyros_Core::payments($lines, $c['inboxes'], $units($order->get_total()));
			if ($r['missing']) {
				throw new RuntimeException(sprintf(__('This shop has no Kyros payment address for VAT %s%%. Add it in the Kyros app.', 'kyros-checkout'), implode('%, ', array_map(fn($b) => $b / 100, $r['missing']))));
			}
			$out = array_map(fn($p) => ['inbox' => $p['inbox'], 'bps' => $p['bps'], 'amount' => (string) $p['amount']], $r['payments']);
			$order->update_meta_data('_kyros_payments', wp_json_encode($out));
			$order->update_meta_data('_kyros_asset', wp_json_encode($c['asset']));
			$order->save();
			return $out;
		}

		public function receipt_page($order_id) {
			$order = wc_get_order($order_id);
			$c = $this->config();
			if (!$order || !$c) {
				return;
			}
			try {
				$payments = self::payments_for($order, $c);
			} catch (Throwable $e) {
				echo '<p class="woocommerce-error">' . esc_html($e->getMessage()) . '</p>';
				return;
			}
			wp_enqueue_script('kyros-checkout', plugins_url('assets/kyros-checkout.js', __FILE__), [], KYROS_CHECKOUT_VERSION, true);
			printf(
				'<kyros-checkout network="%s" rpc="%s" asset-contract="%s" asset-code="%s" payments="%s" status-url="%s" order-key="%s" return-url="%s" lang="%s"></kyros-checkout>',
				esc_attr($c['network']),
				esc_attr((string) $this->get_option('rpc')),
				esc_attr($c['asset']['contract']),
				esc_attr($c['asset']['code']),
				esc_attr(wp_json_encode($payments)),
				esc_url(rest_url('kyros/v1/orders/' . $order->get_id())),
				esc_attr($order->get_order_key()),
				esc_url($this->get_return_url($order)),
				esc_attr(substr(get_locale(), 0, 2))
			);
		}
	}

	add_filter('woocommerce_payment_gateways', function ($gateways) {
		$gateways[] = 'WC_Gateway_Kyros';
		return $gateways;
	});
});

add_action('woocommerce_blocks_payment_method_type_registration', function ($registry) {
	if (class_exists(\Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType::class)) {
		require_once __DIR__ . '/includes/class-kyros-blocks.php';
		$registry->register(new Kyros_Blocks());
	}
});

/**
 * POST /wp-json/kyros/v1/orders/{id} {key, hash|null}: the buyer's browser reports a transfer
 * (or asks what is paid). The hash is checked on chain before anything changes.
 */
add_action('rest_api_init', function () {
	register_rest_route('kyros/v1', '/orders/(?P<id>\d+)', [
		'methods' => 'POST',
		'permission_callback' => '__return_true',
		'callback' => 'kyros_checkout_order_status',
	]);
});

function kyros_checkout_order_status(WP_REST_Request $req) {
	$order = wc_get_order((int) $req['id']);
	$key = (string) $req->get_param('key');
	if (!$order || !hash_equals($order->get_order_key(), $key) || $order->get_payment_method() !== 'kyros') {
		return new WP_REST_Response(['error' => 'unknown order'], 404);
	}
	$payments = json_decode((string) $order->get_meta('_kyros_payments'), true) ?: [];
	$asset = json_decode((string) $order->get_meta('_kyros_asset'), true) ?: [];
	$paid = json_decode((string) $order->get_meta('_kyros_paid'), true) ?: [];
	$hash = strtolower((string) $req->get_param('hash'));
	$gateway = WC()->payment_gateways()->payment_gateways()['kyros'] ?? null;

	if ($hash !== '' && $gateway && !$order->is_paid()) {
		// A transaction pays one order, once.
		$used = wc_get_orders(['limit' => 1, 'return' => 'ids', 'meta_query' => [['key' => '_kyros_tx_' . $hash, 'compare' => 'EXISTS']]]);
		if ($used) {
			return new WP_REST_Response(['error' => 'this transaction was already used'], 409);
		}
		$c = $gateway->config();
		$get = function (string $url) {
			$r = wp_remote_get($url, ['timeout' => 20]);
			return is_wp_error($r) || wp_remote_retrieve_response_code($r) !== 200 ? null : json_decode(wp_remote_retrieve_body($r), true);
		};
		$created = $order->get_date_created();
		$matched = false;
		foreach ($payments as $p) {
			if (isset($paid[$p['inbox']])) {
				continue;
			}
			// The network may take a few seconds to show it.
			for ($try = 0; $try < 3; $try++) {
				$v = Kyros_Core::verify($get, $gateway->horizon($c), $hash, ['to' => $p['inbox'], 'amount' => (int) $p['amount'], 'code' => $asset['code'] ?? '', 'issuer' => $asset['issuer'] ?? ''], $created ? $created->getTimestamp() - 60 : null);
				if ($v['ok'] || $v['reason'] !== 'not-found') {
					break;
				}
				sleep(2);
			}
			if ($v['ok']) {
				$paid[$p['inbox']] = $hash;
				$order->update_meta_data('_kyros_tx_' . $hash, $p['inbox']);
				$order->add_order_note(sprintf('Kyros: %s %s received at the VAT %s%% address, transaction %s.', Kyros_Core::decimal((int) $p['amount']), $asset['code'] ?? '', $p['bps'] / 100, $hash));
				$matched = true;
				break;
			}
		}
		if (!$matched) {
			return new WP_REST_Response(['error' => 'the transaction does not pay this order'], 422);
		}
		$order->update_meta_data('_kyros_paid', wp_json_encode($paid));
		$order->save();
		if (count($paid) === count($payments)) {
			$order->payment_complete(implode(',', array_values($paid)));
		}
	}
	$complete = $order->is_paid() || ($payments && count($paid) === count($payments));
	return new WP_REST_Response([
		'paid' => array_keys($paid),
		'complete' => $complete,
		'redirect' => $complete && $gateway ? $gateway->get_return_url($order) : null,
	]);
}
