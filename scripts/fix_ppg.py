import json, pathlib

PPR = dict(pass_yds=0.04, pass_tds=4.0, rush_yds=0.1, rush_tds=6.0,
           rec=1.0, rec_yds=0.1, rec_tds=6.0)

p    = pathlib.Path('data/vegasprops.json')
data = json.loads(p.read_text())

for name, stats in data['players'].items():
    ppg = round(sum(stats.get(k, 0) / 17 * w for k, w in PPR.items()), 2)
    stats['ppg'] = ppg

p.write_text(json.dumps(data, indent=2))

print('Fixed. Top 10:')
top = sorted(data['players'].items(), key=lambda x: x[1]['ppg'], reverse=True)[:10]
for i, (name, stats) in enumerate(top, 1):
    print(f'  {i:2}. {name:<24} {stats["ppg"]:.1f} PPG')
