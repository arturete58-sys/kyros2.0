/**
 * Keeping Kyros's shared ledger entries alive.
 *
 * Every Soroban entry has a time to live (TTL) and is archived when it runs
 * out. Each vault and inbox extends its own instance whenever it is used, but
 * the wasm code is shared by every vault (and every inbox), and the Router,
 * the Rate Registry, the CCTP receiver and the swapper keep no state that
 * would extend them. Once archived, the next transaction that needs one has
 * to restore it first, and pays for restoring the whole wasm.
 *
 * `keepAlive` reads their TTLs and, for those running low, sends one
 * `ExtendFootprintTTL` transaction. Anyone may extend any entry: the keeper's
 * key only pays the rent and the fee.
 */
import { Address, Keypair, Operation, rpc, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { KyrosClient } from './client.js';

/** Ledgers per day (5 s each). */
export const LEDGERS_PER_DAY = 17_280;

export function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function codeKey(wasmHash: Buffer): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
}

export interface TtlEntry {
  /** What the entry is: a contract ID, or `wasm:<hash>`. */
  name: string;
  key: xdr.LedgerKey;
  /** Ledgers left before it is archived (negative: already archived). */
  left: number;
}

/**
 * The TTL of each contract's instance and of the wasm it runs (each wasm once,
 * however many contracts share it). Contracts that do not exist are skipped.
 */
export async function contractTtls(server: Pick<rpc.Server, 'getLedgerEntries' | 'getLatestLedger'>, contracts: string[], wasmHashes: string[] = []): Promise<TtlEntry[]> {
  const latest = (await server.getLatestLedger()).sequence;
  const res = await server.getLedgerEntries(...contracts.map(instanceKey));
  const out: TtlEntry[] = [];
  const wasms = new Map<string, xdr.LedgerKey>(wasmHashes.map((h) => [h, codeKey(Buffer.from(h, 'hex'))]));
  for (const e of res.entries) {
    const data = e.val.contractData();
    const id = Address.fromScAddress(data.contract()).toString();
    out.push({ name: id, key: e.key, left: (e.liveUntilLedgerSeq ?? 0) - latest });
    const exec = data.val().instance().executable();
    if (exec.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
      const hash = exec.wasmHash();
      wasms.set(hash.toString('hex'), codeKey(hash));
    }
  }
  if (wasms.size) {
    const code = await server.getLedgerEntries(...wasms.values());
    for (const e of code.entries) out.push({ name: `wasm:${e.key.contractCode().hash().toString('hex')}`, key: e.key, left: (e.liveUntilLedgerSeq ?? 0) - latest });
  }
  return out;
}

/** The network's longest TTL, in ledgers (from its state archival settings). */
export async function maxEntryTtl(server: Pick<rpc.Server, 'getLedgerEntries'>): Promise<number | undefined> {
  const key = xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() }));
  const res = await server.getLedgerEntries(key).catch(() => undefined);
  const e = res?.entries[0];
  return e ? e.val.configSetting().stateArchivalSettings().maxEntryTtl() : undefined;
}

export interface KeepAliveResult {
  checked: TtlEntry[];
  /** The entries extended (empty when all had enough time left). */
  extended: string[];
  hash?: string;
}

/**
 * Extends, in one transaction, every entry with less than `minDays` left to
 * `extendDays`, or the network's maximum TTL if that is shorter.
 */
export async function keepAlive(client: KyrosClient, signer: Keypair, contracts: string[], o: { wasmHashes?: string[]; minDays?: number; extendDays?: number } = {}): Promise<KeepAliveResult> {
  const minLeft = (o.minDays ?? 30) * LEDGERS_PER_DAY;
  // An extension past the network's maximum TTL is refused as malformed.
  const max = await maxEntryTtl(client.server);
  const extendTo = Math.min((o.extendDays ?? 120) * LEDGERS_PER_DAY, max ? max - 1 : Infinity);
  const checked = await contractTtls(client.server, contracts, o.wasmHashes);
  const low = checked.filter((t) => t.left < minLeft);
  if (!low.length) return { checked, extended: [] };
  const account = await client.server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: '100000', networkPassphrase: client.o.networkPassphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly(low.map((t) => t.key)).build())
    .setTimeout(120)
    .build();
  const prepared = await client.server.prepareTransaction(tx);
  const sent = await client.submit(prepared as typeof tx, signer);
  return { checked, extended: low.map((t) => t.name), hash: sent.hash };
}
