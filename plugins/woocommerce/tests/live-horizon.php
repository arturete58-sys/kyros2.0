<?php
/**
 * Checks Kyros_Core::verify against Horizon on testnet, with a real transfer
 * into a Kyros payment address made by the testnet demo:
 *   php tests/live-horizon.php ../../docs/testnet/latest.json
 */
define('KYROS_TESTING', true);
require __DIR__ . '/../kyros-checkout/includes/class-kyros-core.php';

$results = json_decode(file_get_contents($argv[1] ?? __DIR__ . '/../../../docs/testnet/latest.json'), true);
$steps = $results['steps'];
$i = null;
foreach ($steps as $k => $s) {
	if (str_starts_with($s['step'], 'A second payment address for clients abroad')) $i = $k;
}
if ($i === null) {
	fwrite(STDERR, "the demo results have no transfer into a payment address\n");
	exit(1);
}
$inbox = $steps[$i]['detail'];
$hash = $steps[$i + 1]['tx'];
$get = function (string $url) {
	$body = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 30, 'ignore_errors' => true]]));
	return $body === false ? null : json_decode($body, true);
};
$expect = ['to' => $inbox, 'amount' => Kyros_Core::units('1000'), 'code' => 'KUSD', 'issuer' => $results['accounts']['issuer']];
$h = 'https://horizon-testnet.stellar.org';
$ok = Kyros_Core::verify($get, $h, $hash, $expect, strtotime($results['startedAt']));
$wrong = Kyros_Core::verify($get, $h, $hash, ['amount' => Kyros_Core::units('999')] + $expect);
echo json_encode(['tx' => $hash, 'inbox' => $inbox, 'paid' => $ok, 'wrongAmount' => $wrong]), "\n";
exit($ok['ok'] && ($wrong['reason'] ?? '') === 'wrong-amount' ? 0 : 1);
