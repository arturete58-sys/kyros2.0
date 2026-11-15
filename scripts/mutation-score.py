#!/usr/bin/env python3
"""Mutation score from one or more cargo-mutants `outcomes.json` files.

Usage: mutation-score.py OUT_MD OUT_BADGE_JSON outcomes.json [outcomes.json ...]

Score = caught / (caught + missed). A mutant that times out is counted as
caught (the tests noticed something was wrong: they did not finish), and
reported separately. Unviable mutants (they do not compile) are left out.
"""
import json
import sys
from collections import defaultdict


def main() -> int:
    out_md, out_badge, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    per = defaultdict(lambda: defaultdict(int))
    missed = []
    for f in files:
        with open(f) as fh:
            data = json.load(fh)
        for o in data.get("outcomes", []):
            scen = o.get("scenario")
            if not isinstance(scen, dict) or "Mutant" not in scen:
                continue
            m = scen["Mutant"]
            pkg = m.get("package", "?")
            kind = o.get("summary", "")
            per[pkg][kind] += 1
            if kind == "MissedMutant":
                missed.append(m.get("name", "?"))
    rows, tc, tm, tt, tu = [], 0, 0, 0, 0
    for pkg in sorted(per):
        c, m = per[pkg]["CaughtMutant"], per[pkg]["MissedMutant"]
        t, u = per[pkg]["Timeout"], per[pkg]["Unviable"]
        tc, tm, tt, tu = tc + c, tm + m, tt + t, tu + u
        score = 100.0 * (c + t) / (c + t + m) if c + t + m else 100.0
        rows.append(f"| {pkg} | {c} | {t} | {m} | {u} | {score:.1f}% |")
    total = 100.0 * (tc + tt) / (tc + tt + tm) if tc + tt + tm else 100.0
    lines = [
        "## Mutation testing",
        "",
        f"**Mutation score: {total:.1f}%** ({tc + tt} of {tc + tt + tm} viable mutants caught)",
        "",
        "| Package | Caught | Timed out | Missed | Unviable | Score |",
        "| --- | --- | --- | --- | --- | --- |",
        *rows,
        f"| **All** | {tc} | {tt} | {tm} | {tu} | **{total:.1f}%** |",
    ]
    if missed:
        lines += ["", "<details><summary>Missed mutants</summary>", "", "```"]
        lines += sorted(missed)
        lines += ["```", "</details>"]
    with open(out_md, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    color = "brightgreen" if total >= 90 else "yellow" if total >= 75 else "red"
    with open(out_badge, "w") as fh:
        json.dump(
            {"schemaVersion": 1, "label": "mutation score", "message": f"{total:.1f}%", "color": color},
            fh,
        )
    print(f"mutation score {total:.1f}% (caught {tc}, timed out {tt}, missed {tm}, unviable {tu})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
