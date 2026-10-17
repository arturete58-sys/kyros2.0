"""Writes rule-packs/holidays/<cc>.json from each pack's calendar.workdays.

For every year it lists two sets of holidays, as MM-DD:
  pay  - the holidays that move the date Kyros shows for paying (the
         country's own rule: national ones, every state's where the tax
         office says so, or one subdivision such as Washington DC);
  lock - every holiday of the country and all its subdivisions, plus the
         extra closed days of the pack. The vault's lock moves past these,
         so it never opens before the legal date wherever the user lives.

Data: the `holidays` Python package (https://github.com/vacanza/holidays).
Run:  pip install holidays==<version below> && python rule-packs/holidays/generate.py
The law watch reruns it with the newest release and reports any change.
"""
import json, glob, os, sys
import holidays

YEARS = range(2025, 2036)
here = os.path.dirname(os.path.abspath(__file__))
packs = os.path.join(here, '..')


def days(h):
    return {d for d in h}


def country(code, years, subdiv=None):
    return holidays.country_holidays(code, subdiv=subdiv, years=years)


def union(code, years):
    out = days(country(code, years))
    for s in holidays.list_supported_countries()[code]:
        try:
            out |= days(country(code, years, s))
        except Exception:
            pass
    return out


def main(check=False):
    changed = []
    for f in sorted(glob.glob(os.path.join(packs, '??.json'))):
        cc = os.path.basename(f)[:2]
        w = json.load(open(f))['calendar']['workdays']
        spec = w.get('holidays', 'national')
        src = cc.upper()
        if isinstance(spec, dict):
            src = spec.get('country', src)
        out = {'source': f'holidays {holidays.__version__}', 'country': src, 'years': {}}
        for y in YEARS:
            if spec == 'union':
                pay = union(src, [y])
            elif isinstance(spec, dict) and 'subdiv' in spec:
                pay = days(country(src, [y], spec['subdiv']))
            else:
                pay = days(country(src, [y]))
            lock = union(src, [y]) | pay
            extra = {__import__('datetime').date(y, int(m[:2]), int(m[3:])) for m in w.get('extra', [])}
            fmt = lambda s: sorted(d.strftime('%m-%d') for d in s if d.year == y)
            out['years'][str(y)] = {'pay': fmt(pay | extra), 'lock': fmt(lock | extra)}
        path = os.path.join(here, f'{cc}.json')
        text = json.dumps(out, indent=1) + '\n'
        old = open(path).read() if os.path.exists(path) else None
        if old is not None and json.loads(old)['years'] != out['years']:
            changed.append(cc)
        if not check:
            open(path, 'w').write(text)
    if changed:
        print('Holidays changed for: ' + ', '.join(changed))
    return changed


if __name__ == '__main__':
    changed = main(check='--check' in sys.argv)
    sys.exit(1 if changed and '--check' in sys.argv else 0)
