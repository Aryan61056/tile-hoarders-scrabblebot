"""Build bot/data/replay.jsonl from the market dump.

One line per ended, all-human, 6-bot match:
  {id, tournament, letters[68], top[68], paid[68], winner[68], bots[6], scores[6]}
`top` is the winning bid (from the public archive), `paid` the second price. For any seat X:
  highest rival bid = paid if X won the auction else top
which is exactly what a replacement bot needs to know whether it would have won and what it would pay.
"""
import json, collections

d = json.load(open('bot/data/market-dump.json'))
T = lambda x: x['tag'] if isinstance(x, dict) else x
sims = {b['id'] for b in d['bot'] if b['isSimulated']}
ended = {m['id'] for m in d['matchState'] if T(m['status']) == 'Ended'}
tm = {t['matchId'] for t in d['tournamentMatch']}
part = collections.defaultdict(list)
for p in d['matchParticipant']:
    if p['matchId'] in ended:
        part[p['matchId']].append(p)
top = {t['auctionId']: int(t['topBid']) for t in d['auctionTopBidArchive']}
byM = collections.defaultdict(list)
for r in d['auctionResult']:
    byM[r['matchId']].append(r)

out = open('bot/data/replay.jsonl', 'w')
n = 0
for m, ps in part.items():
    if len(ps) != 6 or any(p['botId'] in sims for p in ps):
        continue
    rs = sorted(byM[m], key=lambda r: int(r['auctionId']))
    if len(rs) != 68 or any(r['auctionId'] not in top for r in rs):
        continue
    out.write(json.dumps({
        'id': int(m),
        'tournament': m in tm,
        'letters': ''.join(r['letter'] for r in rs),
        'top': [top[r['auctionId']] for r in rs],
        'paid': [int(r['paid']) for r in rs],
        'winner': [(r.get('winnerBotId') if r.get('winnerBotId') not in (None, 'None') else '-1') for r in rs],
        'bots': [p['botId'] for p in ps],
        'scores': [int(p['score']) for p in ps],
    }) + '\n')
    n += 1
print('wrote', n, 'matches')
