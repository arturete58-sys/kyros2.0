<?php
/**
 * Runs inside WordPress with WooCommerce and the plugin active (CI):
 *   wp eval-file tests/wp-integration.php <path to docs/testnet/latest.json>
 *
 * 1. An order with lines at 21%, 10% and 0% is split into one transfer per rate.
 * 2. A real transfer on testnet (made by the testnet demo into a Kyros payment
 *    address) pays an order through the REST endpoint, checked on Horizon; the
 *    same transaction cannot pay a second order.
 */

$results = json_decode(file_get_contents($args[0]), true);
$fails = 0;
function kyros_check(string $what, $got, $want): void {
	global $fails;
	if ($got === $want) {
		WP_CLI::log("ok - $what");
	} else {
		$fails++;
		WP_CLI::warning("not ok - $what\n  got:  " . var_export($got, true) . "\n  want: " . var_export($want, true));
	}
}

$steps = $results['steps'];
$i = null;
foreach ($steps as $k => $s) {
	if (str_starts_with($s['step'], 'A second payment address for clients abroad')) $i = $k;
}
$inbox0 = $steps[$i]['detail'];
$hash = $steps[$i + 1]['tx'];
$C = fn(string $c) => 'C' . str_repeat($c, 55);
$config = [
	'network' => 'testnet',
	'asset' => ['code' => 'KUSD', 'issuer' => $results['accounts']['issuer'], 'contract' => $results['token']],
	'inboxes' => ['2100' => $C('D'), '1000' => $C('E'), '0' => $inbox0],
	'vault' => $results['contracts']['vault'],
];
update_option('woocommerce_kyros_settings', ['enabled' => 'yes', 'title' => 'USDC on Stellar', 'description' => '', 'config' => wp_json_encode($config), 'horizon' => '', 'rpc' => '']);
update_option('woocommerce_currency', 'USD');
update_option('woocommerce_calc_taxes', 'yes');
WC()->payment_gateways()->init();
$gateway = WC()->payment_gateways()->payment_gateways()['kyros'];
kyros_check('the gateway is available in USD', $gateway->is_available(), true);
require_once WP_PLUGIN_DIR . '/kyros-checkout/includes/class-kyros-blocks.php';
$blocks = new Kyros_Blocks();
$blocks->initialize();
kyros_check('the block checkout offers Kyros', $blocks->is_active(), true);
update_option('woocommerce_currency', 'EUR');
kyros_check('not offered when the store’s currency is not the stablecoin’s', $gateway->is_available(), false);
update_option('woocommerce_currency', 'USD');

// Tax rates: 21% standard, 10% reduced.
$std = WC_Tax::_insert_tax_rate(['tax_rate_country' => '', 'tax_rate' => '21.0000', 'tax_rate_name' => 'IVA', 'tax_rate_priority' => 1, 'tax_rate_shipping' => 1, 'tax_rate_class' => '']);
$red = WC_Tax::_insert_tax_rate(['tax_rate_country' => '', 'tax_rate' => '10.0000', 'tax_rate_name' => 'IVA reducido', 'tax_rate_priority' => 1, 'tax_rate_shipping' => 0, 'tax_rate_class' => 'reduced-rate']);

function kyros_line(WC_Order $o, string $name, string $net, ?int $rate, string $pct): void {
	$item = new WC_Order_Item_Fee();
	$item->set_name($name);
	$item->set_total($net);
	$tax = $rate ? wc_format_decimal((float) $net * (float) $pct / 100, 2) : '0';
	$item->set_taxes(['total' => $rate ? [$rate => $tax] : []]);
	$item->set_total_tax($tax);
	$o->add_item($item);
}

// 1. Grouping by rate.
$o = wc_create_order();
kyros_line($o, 'Laptop', '800.00', $std, '21');
kyros_line($o, 'Book', '20.00', $red, '10');
kyros_line($o, 'Gift card', '50.00', null, '0');
kyros_line($o, 'Shipping', '5.00', $std, '21');
$o->set_payment_method('kyros');
$o->save();
$o->update_taxes();
$o->calculate_totals(false);
$o->save();
$p = WC_Gateway_Kyros::payments_for($o, $gateway->config());
kyros_check('one transfer per VAT rate', array_map(fn($x) => [$x['bps'], $x['amount']], $p), [[2100, (string) Kyros_Core::units('974.05')], [1000, (string) Kyros_Core::units('22')], [0, (string) Kyros_Core::units('50')]]);
kyros_check('the transfers add up to the order total', array_sum(array_column($p, 'amount')), Kyros_Core::units((string) $o->get_total()));

// 2. A real transfer of 1,000 KUSD into the 0% address pays an order of 1,000 with no VAT.
$paid = wc_create_order();
kyros_line($paid, 'Consulting abroad', '1000.00', null, '0');
$paid->set_payment_method('kyros');
$paid->save();
$paid->update_taxes();
$paid->calculate_totals(false);
$paid->set_date_created(strtotime($results['startedAt']));
$paid->save();
WC_Gateway_Kyros::payments_for($paid, $gateway->config());
$call = function (WC_Order $order, ?string $h) {
	$r = new WP_REST_Request('POST', '/kyros/v1/orders/' . $order->get_id());
	$r->set_body_params(['key' => $order->get_order_key(), 'hash' => $h]);
	return rest_do_request($r);
};
$bad = $call($paid, str_repeat('0', 64));
kyros_check('an unknown transaction is refused', $bad->get_status(), 422);
$res = $call($paid, $hash);
kyros_check('the transfer on testnet pays the order', [$res->get_status(), $res->get_data()['complete'] ?? null], [200, true]);
kyros_check('the order is paid', wc_get_order($paid->get_id())->is_paid(), true);

$again = wc_create_order();
kyros_line($again, 'Consulting abroad', '1000.00', null, '0');
$again->set_payment_method('kyros');
$again->save();
$again->update_taxes();
$again->calculate_totals(false);
$again->set_date_created(strtotime($results['startedAt']));
$again->save();
WC_Gateway_Kyros::payments_for($again, $gateway->config());
kyros_check('the same transaction cannot pay a second order', $call($again, $hash)->get_status(), 409);
$wrongKey = new WP_REST_Request('POST', '/kyros/v1/orders/' . $again->get_id());
$wrongKey->set_body_params(['key' => 'wc_order_wrong', 'hash' => null]);
kyros_check('the order key is required', rest_do_request($wrongKey)->get_status(), 404);

if ($fails) {
	WP_CLI::error("$fails failed");
}
WP_CLI::success('Kyros checkout works in WooCommerce');
