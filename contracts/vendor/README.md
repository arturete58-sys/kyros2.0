# Third-party contracts used in tests

The adapter tests run Kyros against the real protocols, not against mocks.
These files are only loaded by tests (`contractimport!` / `register`); no
Kyros contract embeds or ships them.

| Folder | What | Source | Licence |
|---|---|---|---|
| `blend/` | Blend v2 pool, pool factory, backstop, emitter and Comet (the backstop token) | crate `blend-contract-sdk` 2.22.0 (`wasm/`), repo `blend-capital/blend-contract-sdk` at `b1aaa360` | MIT (`blend/LICENSE`) |
| `soroswap/` | Soroswap router, factory and pair, as deployed on mainnet in March 2024 | repo `soroswap/core`, `public/mainnet-deployment-2024-03/` at `6eade008` | Apache-2.0 (`soroswap/LICENSE`) |
