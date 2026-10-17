"""Calendar vectors for n-month periods and due dates, from Python's datetime.

Run: python3 gen_calendar.py  (rewrites the "monthsPeriods" and "dues" keys of vectors.json)
"""
import calendar, datetime as dt, json

def ts(d): return calendar.timegm(d.timetuple())

def add_months(y, m, k):
    n = y * 12 + (m - 1) + k
    return n // 12, n % 12 + 1

def period(n, t):
    d = dt.datetime.utcfromtimestamp(t)
    idx = (d.month - 1) // n
    sy, sm = d.year, idx * n + 1
    ey, em = add_months(sy, sm, n)
    return d.year * (12 // n) + idx, ts(dt.datetime(sy, sm, 1)), ts(dt.datetime(ey, em, 1))

def end_of_day(y, m, day):
    last = calendar.monthrange(y, m)[1]
    return ts(dt.datetime(y, m, min(max(day, 1), last))) + 86400

def due(kind_end, rule):
    end = kind_end
    if 'after' in rule: return end + rule['after']
    if 'monthDay' in rule:
        r = rule['monthDay']; d = dt.datetime.utcfromtimestamp(end)
        last_month = dt.datetime.utcfromtimestamp(end - 1).month
        exc = r['exceptionMonth'] != 0 and last_month == r['exceptionMonth']
        months, day = (r['exceptionMonths'], r['exceptionDay']) if exc else (r['months'], r['day'])
        y, m = add_months(d.year, d.month, months)
        return end_of_day(y, m, day)
    r = rule['yearDate']; last = dt.datetime.utcfromtimestamp(end - 1)
    fy = last.year if (last.month, last.day) >= (r['fyStartMonth'], r['fyStartDay']) else last.year - 1
    return end_of_day(fy + r['yearsAfter'], r['month'], r['day'])

stamps = [dt.datetime(2026, 1, 1), dt.datetime(2026, 2, 28, 23, 59, 59), dt.datetime(2026, 3, 31, 12), dt.datetime(2026, 4, 5, 23),
          dt.datetime(2026, 4, 6), dt.datetime(2026, 6, 30, 23, 59, 59), dt.datetime(2026, 7, 1), dt.datetime(2026, 12, 31, 23, 59, 59),
          dt.datetime(2027, 1, 1), dt.datetime(2028, 2, 29, 10)]
months_periods = []
for s in stamps:
    t = ts(s); row = {'ts': str(t)}
    for n in (2, 4, 6):
        i, a, b = period(n, t); row[f'months{n}'] = {'id': i, 'start': str(a), 'end': str(b)}
    months_periods.append(row)

KIND_MONTHS = {'Month': 1, 'Quarter': 3, 'Year': 12, 'Months2': 2, 'Months4': 4, 'Months6': 6}
rules = {
    'es-vat': {'monthDay': {'months': 0, 'day': 20, 'exceptionMonth': 12, 'exceptionMonths': 0, 'exceptionDay': 30}},
    'au-gst': {'monthDay': {'months': 0, 'day': 28, 'exceptionMonth': 12, 'exceptionMonths': 1, 'exceptionDay': 28}},
    'pt-iva': {'monthDay': {'months': 1, 'day': 25, 'exceptionMonth': 6, 'exceptionMonths': 2, 'exceptionDay': 25}},
    'gb-vat': {'monthDay': {'months': 1, 'day': 7, 'exceptionMonth': 0, 'exceptionMonths': 0, 'exceptionDay': 0}},
    'last-day': {'monthDay': {'months': 0, 'day': 31, 'exceptionMonth': 0, 'exceptionMonths': 0, 'exceptionDay': 0}},
    'es-renta': {'yearDate': {'fyStartMonth': 1, 'fyStartDay': 1, 'month': 6, 'day': 30, 'yearsAfter': 1}},
    'gb-sa': {'yearDate': {'fyStartMonth': 4, 'fyStartDay': 6, 'month': 1, 'day': 31, 'yearsAfter': 2}},
    'au-income': {'yearDate': {'fyStartMonth': 7, 'fyStartDay': 1, 'month': 10, 'day': 31, 'yearsAfter': 1}},
    'feb-29': {'yearDate': {'fyStartMonth': 1, 'fyStartDay': 1, 'month': 2, 'day': 29, 'yearsAfter': 1}},
    'after-60d': {'after': 60 * 86400},
}
dues = []
for kind, n in KIND_MONTHS.items():
    for s in stamps:
        t = ts(s); d = dt.datetime.utcfromtimestamp(t)
        idx = (d.month - 1) // n
        pid = d.year * (12 // n) + idx
        ey, em = add_months(d.year, idx * n + 1, n)
        end = ts(dt.datetime(ey, em, 1))
        for name, r in rules.items():
            dues.append({'kind': kind, 'id': pid, 'rule': name, 'due': str(due(end, r))})

v = json.load(open('vectors.json'))
v['monthsPeriods'] = months_periods
v['dueRules'] = rules
v['dues'] = dues
json.dump(v, open('vectors.json', 'w'), indent=1)
print(len(months_periods), len(dues))
