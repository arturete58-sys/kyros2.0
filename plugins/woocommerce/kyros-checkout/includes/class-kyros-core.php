<?php
/**
 * Kyros checkout: the parts that do not depend on WordPress (tested on their own).
 *
 * An order is paid with one token transfer per VAT rate in it, each to the
 * seller's Kyros payment address for that rate. The seller's vault splits
 * every payment on arrival: the VAT and the income-tax reserve stay locked,
 * the rest goes to the seller. This code only computes those transfers and
 * checks on chain (through Horizon) that they happened. It never holds a key.
 */

if (!defined('ABSPATH') && !defined('KYROS_TESTING')) {
	exit;
}

final class Kyros_Core {
	const DECIMALS = 7;

	/** "12.1" → "121000000" (token units). Rejects negatives and more than 7 decimals. */
	public static function units(string $amount): int {
		$s = trim($amount);
		if (!preg_match('/^(\d+)(?:\.(\d+))?$/', $s, $m)) {
			throw new InvalidArgumentException("not an amount: $amount");
		}
		$frac = rtrim($m[2] ?? '', '0');
		if (strlen($frac) > self::DECIMALS) {
			throw new InvalidArgumentException("more than 7 decimals: $amount");
		}
		return intval($m[1]) * 10 ** self::DECIMALS + intval(str_pad($frac, self::DECIMALS, '0'));
	}

	/** 121000000 → "12.1". */
	public static function decimal(int $units): string {
		$whole = intdiv($units, 10 ** self::DECIMALS);
		$frac = rtrim(str_pad((string) ($units % 10 ** self::DECIMALS), self::DECIMALS, '0', STR_PAD_LEFT), '0');
		return $frac === '' ? (string) $whole : "$whole.$frac";
	}

	/**
	 * The seller's configuration, as the Kyros app gives it:
	 * {"network":"testnet","asset":{"code":"USDC","issuer":"G...","contract":"C..."},"inboxes":{"2100":"C...","0":"C..."},"vault":"C..."}
	 *
	 * @return array{network:string,asset:array{code:string,issuer:string,contract:string},inboxes:array<int,string>,vault:string}
	 */
	public static function config(string $json): array {
		$c = json_decode($json, true);
		if (!is_array($c) || !isset($c['network'], $c['asset']['code'], $c['asset']['issuer'], $c['asset']['contract'], $c['inboxes']) || !is_array($c['inboxes'])) {
			throw new InvalidArgumentException('the Kyros configuration is not valid JSON from the Kyros app');
		}
		if (!in_array($c['network'], ['testnet', 'pubnet'], true)) {
			throw new InvalidArgumentException('network must be testnet or pubnet');
		}
		$inboxes = [];
		foreach ($c['inboxes'] as $bps => $inbox) {
			if (!preg_match('/^\d+$/', (string) $bps) || !self::is_contract($inbox)) {
				throw new InvalidArgumentException("bad payment address for rate $bps");
			}
			$inboxes[intval($bps)] = $inbox;
		}
		return ['network' => $c['network'], 'asset' => $c['asset'], 'inboxes' => $inboxes, 'vault' => (string) ($c['vault'] ?? '')];
	}

	public static function is_contract($a): bool {
		return is_string($a) && preg_match('/^C[A-Z2-7]{55}$/', $a) === 1;
	}

	/**
	 * The transfers that pay an order. `$lines`: [['net' => units, 'vat' => units, 'bps' => int], ...]
	 * (products, shipping, fees). `$total`: the order total in units: if the shop's rounding makes
	 * the lines differ from it by a few units, the largest transfer takes the difference, so the
	 * buyer pays exactly the order total.
	 *
	 * @return array{payments: list<array{inbox:string,bps:int,amount:int}>, missing: list<int>}
	 */
	public static function payments(array $lines, array $inboxes, ?int $total = null): array {
		$groups = [];
		foreach ($lines as $l) {
			$net = intval($l['net']);
			$vat = intval($l['vat']);
			if ($net < 0 || $vat < 0) {
				throw new InvalidArgumentException('negative line amount');
			}
			if ($net + $vat === 0) {
				continue;
			}
			$bps = intval($l['bps']);
			$groups[$bps] = ($groups[$bps] ?? 0) + $net + $vat;
		}
		krsort($groups);
		if ($total !== null && $groups) {
			$diff = $total - array_sum($groups);
			// Only rounding: a cent or so per line.
			if (abs($diff) > 100000 * count($lines)) {
				throw new RuntimeException('the order lines do not add up to its total');
			}
			$largest = array_search(max($groups), $groups, true);
			$groups[$largest] += $diff;
		}
		$payments = [];
		$missing = [];
		foreach ($groups as $bps => $amount) {
			if (isset($inboxes[$bps])) {
				$payments[] = ['inbox' => $inboxes[$bps], 'bps' => $bps, 'amount' => $amount];
			} else {
				$missing[] = $bps;
			}
		}
		return ['payments' => $payments, 'missing' => $missing];
	}

	/** A tax rate as a percentage ("21.0000") → basis points (2100). */
	public static function bps($percent): int {
		return intval(round(floatval($percent) * 100));
	}

	/**
	 * Whether transaction `$hash` transferred `$expect['amount']` units of the asset
	 * (`code`, `issuer`) into `$expect['to']`, no earlier than `$not_before` (Unix time).
	 * `$get(url)` returns the decoded JSON of a Horizon URL, or null if it is not there.
	 *
	 * @return array{ok:bool, reason?:string, from?:string, at?:string}
	 */
	public static function verify(callable $get, string $horizon, string $hash, array $expect, ?int $not_before = null): array {
		if (!preg_match('/^[0-9a-f]{64}$/', $hash)) {
			return ['ok' => false, 'reason' => 'bad-hash'];
		}
		$base = rtrim($horizon, '/');
		$tx = $get("$base/transactions/$hash");
		if (!is_array($tx) || !isset($tx['hash'])) {
			return ['ok' => false, 'reason' => 'not-found'];
		}
		if (empty($tx['successful'])) {
			return ['ok' => false, 'reason' => 'failed'];
		}
		if ($not_before !== null && strtotime((string) $tx['created_at']) < $not_before) {
			return ['ok' => false, 'reason' => 'too-old'];
		}
		$ops = $get("$base/transactions/$hash/operations?limit=200");
		$paid = 0;
		$from = null;
		foreach ($ops['_embedded']['records'] ?? [] as $op) {
			foreach ($op['asset_balance_changes'] ?? [] as $c) {
				$code = $c['asset_code'] ?? $c['code'] ?? '';
				$issuer = $c['asset_issuer'] ?? $c['issuer'] ?? '';
				if (($c['type'] ?? '') !== 'transfer' || ($c['to'] ?? '') !== $expect['to'] || $code !== $expect['code'] || $issuer !== $expect['issuer']) {
					continue;
				}
				$paid += self::units((string) $c['amount']);
				$from = $from ?? ($c['from'] ?? null);
			}
		}
		if ($paid === 0) {
			return ['ok' => false, 'reason' => 'no-transfer'];
		}
		if ($paid !== intval($expect['amount'])) {
			return ['ok' => false, 'reason' => 'wrong-amount'];
		}
		return ['ok' => true, 'from' => (string) $from, 'at' => (string) $tx['created_at']];
	}
}
