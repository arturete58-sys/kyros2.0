# Security policy

Kyros holds people's tax reserve in Soroban contracts on Stellar. We take
every report seriously, and we would rather hear about a problem twice than
not at all.

## Status

The contracts run on **Stellar testnet only**. Nothing is deployed on
mainnet, and no real money is at stake yet. The contracts have been through
four internal review passes ([docs/security-review.md](docs/security-review.md))
but **not yet through an external audit**; the audit scope is prepared in
[docs/audit/AUDIT_SCOPE.md](docs/audit/AUDIT_SCOPE.md).

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest `v*` release | Yes |
| Older releases | No: contracts are immutable, so a fix ships as a new version that vaults move to (see [docs/migration.md](docs/migration.md)) |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a
security problem.**

Report it privately through GitHub:
**[Report a vulnerability](https://github.com/arturete58-sys/kyros2.0/security/advisories/new)**
(the repository's *Security* tab, *Report a vulnerability*). Only the
maintainers see it, and we can work on the fix and the advisory together in
a private fork.

A useful report has:

- the contract (or SDK module, app screen, plugin) and the function;
- what an attacker can do, and what they need (a signature, a role, a
  token, a timing);
- a reproduction: ideally a failing test in the style of
  `contracts/test-suites/tests/`, or a sequence of calls on testnet;
- the commit or release you looked at.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | Within 72 hours |
| First assessment (valid or not, severity) | Within 7 days |
| Fix for a critical or high finding | Within 14 days of the assessment |
| Fix for a medium or low finding | In the next release |
| Public advisory | Once a fix is released, coordinated with the reporter |

Severity follows the impact on funds and on the guarantees in
[docs/threat-model.md](docs/threat-model.md): **critical** when reserve or
payments can be taken or redirected, **high** when they can be locked or a
guarantee broken (the lock, the notice, exact splits), **medium** for denial
of service or wrong figures without loss, **low** for the rest.

## Recognition

There is **no paid bug bounty** at this stage: the contracts are on testnet
and the project is not funded for one. Every valid report is credited by
name (or anonymously, as you prefer) in the GitHub advisory and in
[CHANGELOG.md](CHANGELOG.md). A paid programme will be set up before any
mainnet deployment holds real funds, and reports made before it will be
remembered.

## Scope

**In scope**

- The Soroban contracts in `contracts/` (Reserve Vault, Router, Inbox, CCTP
  receiver, Rate Registry, Soroswap swapper, Blend and Ondo adapters) and
  their shared crate `kyros-types`.
- The TypeScript SDK in `sdk/` (transaction building, signing flows, the
  keeper and the guardian).
- The web app in `app/` and the checkout plugins in `plugins/`, where a flaw
  could make a user sign something they did not intend or lose funds.
- The release pipeline (`.github/workflows/release.yml`): anything that
  would let a wasm be attested as built from this repository when it was not.

**Out of scope**

- The testnet keys published on purpose in `app/public/testnet.json` (a
  test-token issuer and a faucet account). They hold only testnet assets.
- Third-party contracts and services (Circle CCTP, Reflector, Soroswap,
  Blend, the Stellar network and its RPC providers). Report those to their
  owners; tell us too if Kyros is affected.
- Denial of service against testnet infrastructure, social engineering,
  physical attacks, and findings that need a compromised device or wallet
  of the victim.
- Tax-law content of the rule packs (please open a normal issue for those).

## Safe harbour

We will not pursue anyone who researches in good faith: on testnet or on
their own deployments, without touching other people's funds or data,
reporting privately and giving us reasonable time to fix before disclosing.

## How the contracts are protected

A short map for reviewers; the details are in the linked documents.

- **No admin over money, no upgrade path.** Each user owns their vault.
  Kyros holds no key that can move, freeze or upgrade anything
  ([docs/migration.md](docs/migration.md)).
- **Notice on every change that could redirect the reserve**, watched by a
  guardian that alerts the user.
- **The lock**: reserve goes back to its owner only after its due date;
  before that, only to the tax destination.
- **Checked arithmetic**: every amount operation is checked and fails with a
  readable error; unchecked arithmetic does not compile.
- **Testing**: unit and integration tests under mainnet resource limits,
  one adversarial test per threat, stateful property tests on every
  contract, nightly coverage-guided fuzzing, mutation testing, and
  coverage of the contract code ([contracts/README.md](contracts/README.md)).
- **Verifiable builds**: each release's wasm carries its source repository
  and version and a GitHub build attestation (SEP-0055), so anyone can check
  that a deployed contract was built from this code.
