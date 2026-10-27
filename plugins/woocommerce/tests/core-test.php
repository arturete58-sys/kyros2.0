<?php
/** Tests for Kyros_Core without WordPress: php tests/core-test.php */
define('KYROS_TESTING', true);
require __DIR__ . '/../kyros-checkout/includes/class-kyros-core.php';

$fails = 0;
function check(string $what, $got, $want): void {
	global $fails;
	if ($got === $want) {
		echo "ok - $what\n";
	} else {
		$fails++;
		echo "not ok - $what\n  got:  " . var_export($got, true) . "\n  want: " . var_export($want, true) . "\n";
	}
}
function throws(string $what, callable $f): void {
	try {
		$f();
		check($what, 'no exception', 'exception');
	} catch (Throwable $e) {
		check($what, 'exception', 'exception');
	}
}

check('units', Kyros_Core::units('12.1'), 121000000);
check('units, whole', Kyros_Core::units('1000'), 10000000000);
check('decimal', Kyros_Core::decimal(121000000), '12.1');
check('decimal, small', Kyros_Core::decimal(1210), '0.000121');
throws('units refuses 8 decimals', fn() => Kyros_Core::units('0.00000001'));
throws('units refuses negatives', fn() => Kyros_Core::units('-1'));
check('bps', Kyros_Core::bps('21.0000'), 2100);
check('bps, reduced', Kyros_Core::bps('5.5'), 550);

$C = fn(string $c) => 'C' . str_repeat($c, 55);
$cfg = Kyros_Core::config(json_encode(['network' => 'testnet', 'asset' => ['code' => 'USDC', 'issuer' => 'G' . str_repeat('A', 55), 'contract' => $C('B')], 'inboxes' => ['2100' => $C('D'), '1000' => $C('E'), '0' => $C('F')], 'vault' => $C('G')]));
check('config inboxes', $cfg['inboxes'], [2100 => $C('D'), 1000 => $C('E'), 0 => $C('F')]);
throws('config refuses a bad address', fn() => Kyros_Core::config('{"network":"testnet","asset":{"code":"USDC","issuer":"G","contract":"C"},"inboxes":{"2100":"GABC"}}'));

// An order: a book at 4% (Spain), a laptop at 21%, shipping at 21% and a gift card with no VAT.
$u = fn(string $x) => Kyros_Core::units($x);
$lines = [
	['net' => $u('20'), 'vat' => $u('0.8'), 'bps' => 400],
	['net' => $u('800'), 'vat' => $u('168'), 'bps' => 2100],
	['net' => $u('5'), 'vat' => $u('1.05'), 'bps' => 2100],
	['net' => $u('50'), 'vat' => 0, 'bps' => 0],
];
$r = Kyros_Core::payments($lines, $cfg['inboxes'], $u('1044.85'));
check('payments by rate', $r['payments'], [['inbox' => $C('D'), 'bps' => 2100, 'amount' => $u('974.05')], ['inbox' => $C('F'), 'bps' => 0, 'amount' => $u('50')]]);
check('a rate with no address is reported', $r['missing'], [400]);
// Rounding: the shop's total is a cent above the lines; the largest transfer takes it.
$r2 = Kyros_Core::payments([['net' => $u('10'), 'vat' => $u('2.1'), 'bps' => 2100], ['net' => $u('3'), 'vat' => 0, 'bps' => 0]], $cfg['inboxes'], $u('15.11'));
check('rounding goes to the largest transfer', array_column($r2['payments'], 'amount'), [$u('12.11'), $u('3')]);
throws('lines far from the total are refused', fn() => Kyros_Core::payments([['net' => $u('10'), 'vat' => 0, 'bps' => 0]], $cfg['inboxes'], $u('20')));

// Horizon answers, as the API returns them.
$hash = str_repeat('a', 64);
$to = $C('D');
$issuer = 'G' . str_repeat('A', 55);
$horizon = function (array $changes, bool $ok = true, string $at = '2026-10-27T12:00:00Z') use ($hash) {
	return function (string $url) use ($changes, $ok, $at, $hash) {
		if (str_ends_with($url, "/transactions/$hash")) return ['hash' => $hash, 'successful' => $ok, 'created_at' => $at, 'ledger' => 100];
		if (str_contains($url, "/transactions/$hash/operations")) return ['_embedded' => ['records' => [['type' => 'invoke_host_function', 'asset_balance_changes' => $changes]]]];
		return null;
	};
};
$good = [['asset_type' => 'credit_alphanum4', 'asset_code' => 'USDC', 'asset_issuer' => $issuer, 'type' => 'transfer', 'from' => 'GBUYER', 'to' => $to, 'amount' => '974.0500000']];
$expect = ['to' => $to, 'amount' => $u('974.05'), 'code' => 'USDC', 'issuer' => $issuer];
check('verify: paid', Kyros_Core::verify($horizon($good), 'https://h', $hash, $expect, strtotime('2026-10-27T11:00:00Z')), ['ok' => true, 'from' => 'GBUYER', 'at' => '2026-10-27T12:00:00Z']);
check('verify: wrong amount', Kyros_Core::verify($horizon($good), 'https://h', $hash, ['amount' => $u('974.06')] + $expect)['reason'], 'wrong-amount');
check('verify: another address', Kyros_Core::verify($horizon($good), 'https://h', $hash, ['to' => $C('E')] + $expect)['reason'], 'no-transfer');
check('verify: another asset', Kyros_Core::verify($horizon($good), 'https://h', $hash, ['issuer' => 'G' . str_repeat('B', 55)] + $expect)['reason'], 'no-transfer');
check('verify: failed transaction', Kyros_Core::verify($horizon($good, false), 'https://h', $hash, $expect)['reason'], 'failed');
check('verify: before the order', Kyros_Core::verify($horizon($good), 'https://h', $hash, $expect, strtotime('2026-10-27T13:00:00Z'))['reason'], 'too-old');
check('verify: unknown hash', Kyros_Core::verify(fn() => null, 'https://h', $hash, $expect)['reason'], 'not-found');
check('verify: not a hash', Kyros_Core::verify(fn() => null, 'https://h', 'x', $expect)['reason'], 'bad-hash');
// The field names Horizon's docs use (code/issuer) are read too.
$alt = [['asset_type' => 'credit_alphanum4', 'code' => 'USDC', 'issuer' => $issuer, 'type' => 'transfer', 'from' => 'GBUYER', 'to' => $to, 'amount' => '974.0500000']];
check('verify: code/issuer field names', Kyros_Core::verify($horizon($alt), 'https://h', $hash, $expect)['ok'], true);

echo $fails ? "\n$fails failed\n" : "\nall passed\n";
exit($fails ? 1 : 0);
