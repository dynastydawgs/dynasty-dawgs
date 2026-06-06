import requests, json

H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'}

def probe(label, url):
    try:
        r = requests.get(url, headers=H, timeout=15)
        if r.status_code != 200:
            print(f'[{r.status_code}] {label}')
            return None
        data = r.json()
        size = len(r.content)
        print(f'[200] {size:>8}b  {label}')

        # Print any links found in the data for discovery
        raw = json.dumps(data)
        if any(kw in raw.lower() for kw in ['passing yard', 'rushing yard', 'receiving yard', 'touchdown', 'reception']):
            print(f'       *** PLAYER PROPS KEYWORDS FOUND ***')
            # Sample the first market/outcome with player names
            for item in (data if isinstance(data, list) else [data]):
                for event in item.get('events', []) if isinstance(item, dict) else []:
                    desc = event.get('description', '')
                    if any(kw in desc.lower() for kw in ['passing', 'rushing', 'receiving', 'touchdown', 'reception']):
                        print(f'       Event: {desc}')
                        for dg in event.get('displayGroups', [])[:1]:
                            for mkt in dg.get('markets', [])[:3]:
                                outcomes = mkt.get('outcomes', [])
                                if outcomes:
                                    oc = outcomes[0]
                                    price = oc.get('price', {})
                                    hc = price.get('handicap', '')
                                    print(f'         {mkt.get("description","")} | {oc.get("description","")} {hc}')

        # Print path links for discovery
        links = set()
        def find_links(obj, depth=0):
            if depth > 5 or not obj: return
            if isinstance(obj, dict):
                lnk = obj.get('link', '')
                if lnk and '/football/' in lnk: links.add(lnk)
                for v in obj.values(): find_links(v, depth+1)
            elif isinstance(obj, list):
                for v in obj: find_links(v, depth+1)
        find_links(data)
        if links:
            print('       Links found:')
            for l in sorted(links)[:20]: print(f'         {l}')
        return data
    except Exception as e:
        print(f'[ERR] {label}: {e}')
        return None

print('=== Bovada NFL futures (232K) ===')
probe('NFL futures', 'https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl-futures')

print('\n=== Bovada individual player prop paths ===')
for slug in [
    'nfl-player-season-specials',
    'nfl-player-props',
    'nfl-season-player-specials',
    'nfl-individual-specials',
    'nfl-player-passing-yards',
    'nfl-regular-season-player-props',
    'nfl-player-season-props',
    'nfl-season-specials',
    'nfl-specials',
    'nfl-individual-player-specials',
    'nfl-regular-season-passing-yards',
]:
    probe(slug, f'https://www.bovada.lv/services/sports/event/v2/events/A/description/football/{slug}')
