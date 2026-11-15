# Contract lifecycle and migration

How Kyros contracts change over time, and why they are never upgraded in
place.

## No upgrade in place, by design

Soroban lets a contract replace its own code with
`env.deployer().update_current_contract_wasm(new_wasm_hash)`. Whoever may
call that function controls everything the contract holds: the new code can
do anything with the reserve. Protocols that use it (Phoenix, Reflector)
give that power to an admin or a DAO.

Kyros does not. **No Kyros contract calls `update_current_contract_wasm`,
and none has an admin over money.** A vault holds one person's tax reserve;
an upgrade key held by Kyros would be a single key over every user's
reserve, and the most valuable target in the system. Immutability makes the
code a user checked (or had audited) the code that runs, for as long as the
contract exists.

The cost is that a new version is a new contract, and moving to it is the
owner's decision, with notice. The rest of this document is that procedure.

| Contract | Instances | Who can change it | How a new version arrives |
| --- | --- | --- | --- |
| Reserve Vault | one per user | Nobody's code; the owner changes its settings, with notice | The owner deploys a new vault and moves to it |
| Inbox | one per user | Nobody's code; the owner points it at another vault, with notice | `propose_vault` to the new vault, or a new Inbox |
| Router, CCTP receiver, swapper | one each, shared | Nobody | A new deployment; the SDK and app point to it; the old one keeps working |
| Rate Registry | one per network | Its publisher writes rates; nobody changes its code | A new registry; each vault `unfollow`s the old one and `follow`s the new one |
| Yield adapters | one per vault | Nobody; only their vault moves funds | `stop_strategy` (at once), then `propose_strategy` with the new adapter (with notice) |

## Versions

- The workspace version in `contracts/Cargo.toml` is the version of every
  contract. A release tag `vX.Y.Z` must match it, or the release workflow
  refuses to build.
- Each released wasm carries its version and source repository in its
  `contractmetav0` section (`version`, `source_repo`), and a GitHub build
  attestation (SEP-0055). `stellar contract info meta --wasm <file>` reads
  them; `gh attestation verify <file> --repo arturete58-sys/kyros2.0` checks
  where the wasm was built.
- Interfaces are versioned by semver: a removed or changed public function,
  event or error code is a major version; error codes are only ever
  appended, never renumbered.

## Storage across versions

There is no storage migration, because no contract changes its own code:
an old vault keeps its own entries, under its own keys, with the code that
wrote them.

- **Instance storage** (configuration, pending changes, small lists) and
  **persistent storage** (period books, invoice and payer terms, due dates,
  scheduled payments, corrections) stay in the old vault. Nothing in Kyros
  uses temporary storage.
- Entries stay alive while the old vault is used (each write extends them to
  the network's maximum) and are restored automatically by the transaction
  that needs them if they were archived (Protocol 23). An owner winding down
  an old vault never loses its books.
- A new vault starts empty. Its rules come from the rule pack and the
  owner's settings, set at deployment.

## Moving a vault to a new version

What the owner does, from the app or the SDK. Every step that could
redirect money waits for the old vault's notice period.

1. **Deploy the new vault**, with the same owner, the rules from the rule
   pack, and a notice at least as long as the old one.
2. **Move the Inbox**: `inbox.propose_vault(new_vault)`. The Inbox checks
   that the new vault has the same owner; the move applies when the old
   vault's notice has passed, and `cancel_move` withdraws it until then.
   Payment links and invoices that name the Router can name the new vault at
   once.
3. **Let the old vault wind down.** Its reserve stays locked as before:
   - tax is paid from it to the tax destination as usual (`pay_tax`,
     scheduled payments);
   - each bucket goes back to the owner on its due date (`release`).
4. **Or move the reserve now** (optional): for each bucket,
   `propose_correction` on the old vault (it waits the notice), then
   `apply_correction` (it pays the owner), then `deposit` into the same
   period and bucket of the new vault. The reserve is outside both vaults
   only between those last two calls, in the owner's own account, inside
   one session of the app.
5. **Stop anything opt-in on the old vault**: `stop_strategy` brings the
   lent reserve back (at once, or over the following days if the pool is
   fully lent), `stop_conversion` stops swaps.

## Moving the shared contracts

- **Router, CCTP receiver, swapper**: deploy the new version; update the
  addresses in the SDK configuration and the app; the old deployment keeps
  serving anyone who still calls it. The keeper keeps both alive while both
  are in use.
- **Rate Registry**: deploy the new registry, seed it with the current
  rates, then each vault calls `unfollow` (at once; the vault keeps the rate
  in force as its own) and `follow(new_registry, …)`, which requires the new
  registry's notice to be at least the vault's and its current rate to match.
- **Publisher key of the registry**: `set_admin`, signed by the current
  publisher (a multisig of rule-pack maintainers). The publisher cannot move
  money and cannot change a rate sooner than the registry's notice.

## Emergency procedures

There is no pause and no admin: nobody can freeze a vault, including Kyros.
What exists is in the owner's hands, and acts at once:

| Situation | What the owner does | Effect |
| --- | --- | --- |
| A pending change they did not make | `cancel` (rule, destination, payout address, fixed amounts, new token), `stop_strategy` / `stop_conversion` (a pending strategy or conversion), `cancel_correction`; the guardian alerts them | The change never applies |
| A yield protocol in trouble | `stop_strategy` | Everything comes back now, or as soon as the pool pays out; nothing more goes in |
| A swap venue or oracle in trouble | `stop_conversion` | No more swaps |
| A registry rate that looks wrong | `unfollow` | The vault keeps the rate in force as its own |
| The owner's key may be compromised | Cancel every pending proposal (the guardian lists them), then move to a new vault with a new key as above | The notice period is the window in which the owner can always undo an attacker's proposal |

A bug in a contract is handled by a new version and a move, as above,
coordinated through a GitHub security advisory ([SECURITY.md](../SECURITY.md)).

## If an upgrade path were ever added

Not planned. If a future major version had one, it would have to keep the
guarantees that make the vault trustworthy:

- only the vault's own owner could upgrade it, never a Kyros key;
- the upgrade would be a proposal with the vault's full notice period,
  announced by an event the guardian watches, and cancellable;
- the new wasm would have to be a released, attested Kyros build (its hash
  listed in a release's `SHA256SUMS`);
- storage would carry a schema version key, and the new code would migrate
  entries lazily, on first touch, never in one unbounded call.
