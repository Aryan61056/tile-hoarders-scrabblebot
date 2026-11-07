import json,collections,statistics as st
d=json.load(open('bot/data/market-dump.json'))
T=lambda x: x['tag'] if isinstance(x,dict) else x
ms={m['id']:m for m in d['matchState']}
print('tournament matches phases',collections.Counter(T(x['phase']) for x in d['tournamentMatch']))
print('match status',collections.Counter(T(m['status']) for m in ms.values()))
print('auctionType',collections.Counter(T(m['auctionType']) for m in ms.values()))
print('startingRack',collections.Counter(m['startingRackSize'] for m in ms.values()))
print('auctionMs',collections.Counter(m['auctionDurationMs'] for m in ms.values()))
part=collections.defaultdict(list)
for p in d['matchParticipant']: part[p['matchId']].append(p)
print('match sizes',collections.Counter(len(v) for v in part.values()))
bots={b['id']:b for b in d['bot']}
print('bots',len(bots),'simulated',sum(1 for b in bots.values() if b['isSimulated']),collections.Counter(T(b['strategy']) for b in bots.values() if b['isSimulated']))
# price by letter
res=[r for r in d['auctionResult']]
top={t['auctionId']:int(t['topBid']) for t in d['auctionTopBidArchive']}
bylet=collections.defaultdict(list); bytop=collections.defaultdict(list)
nobid=0
for r in res:
    if r.get('winnerBotId') in (None,'None'): nobid+=1; continue
    bylet[r['letter']].append(int(r['paid']))
    if r['auctionId'] in top: bytop[r['letter']].append(top[r['auctionId']])
print('auctions',len(res),'no winner',nobid)
print('letter n  paid_med paid_mean | topbid_med topbid_mean')
for L in sorted(bylet,key=lambda L:-st.median(bylet[L])):
    b=bylet[L];t=bytop.get(L,[0])
    print(f'{L}  {len(b):7d} {st.median(b):5.1f} {st.mean(b):6.1f} | {st.median(t):5.1f} {st.mean(t):6.1f}')
allp=[x for v in bylet.values() for x in v]
print('overall paid median',st.median(allp),'mean',round(st.mean(allp),2))
