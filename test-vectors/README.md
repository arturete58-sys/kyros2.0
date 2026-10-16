# Test vectors

`vectors.json` holds split cases (six rules, twelve amounts each) and calendar cases (months, quarters, years and fixed 60-second periods around year and leap-day boundaries). They were generated with an independent Python implementation (`datetime`, `calendar.timegm`) and are checked by both `contracts/types` (Rust) and `sdk` (TypeScript), so the contracts and the SDK cannot drift apart.
