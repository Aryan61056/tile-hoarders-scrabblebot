import json,collections,statistics as st
d=json.load(open('bot/data/market-dump.json'))
T=lambda x: x['tag'] if isinstance(x,dict) else x
bots={b['id']:b for b in d['bot']}
stats={s['botId']:s for s in d['botStats']}
ended={m['id'] for m in d['matchState'] if T(m['status'])=='Ended'}
# per (match,bot)
won=collections.defaultdict(lambda:[0,0])   # tiles, paid
for r in d['auctionResult']:
    w=r.get('winnerBotId')
    if w in (None,'None') or r['matchId'] not in ended: continue
    k=(r['matchId'],w); won[k][0]+=1; won[k][1]+=int(r['paid'])
words=collections.defaultdict(list)
for w in d['wordPlay']:
    if w['matchId'] in ended: words[(w['matchId'],w['botId'])].append(w)
rows={}
for p in d['matchParticipant']:
    if p['matchId'] not in ended: continue
    k=(p['matchId'],p['botId'])
    ws=words.get(k,[]); tw=won.get(k,[0,0])
    L=[len(x['word']) for x in ws]
    rows[k]=dict(score=int(p['score']),bal=int(p['balance']),tiles=tw[0],paid=tw[1],nw=len(ws),
        avgL=(sum(L)/len(L) if L else 0),long7=sum(1 for l in L if l>=7),tilesPlayed=sum(L))
byb=collections.defaultdict(list)
for (m,b),r in rows.items(): byb[b].append(r)
def agg(b):
    rs=byb[b]; f=lambda k: st.mean(r[k] for r in rs)
    return dict(n=len(rs),score=f('score'),tiles=f('tiles'),paid=f('paid'),nw=f('nw'),avgL=f('avgL'),long7=f('long7'),bal=f('bal'),played=f('tilesPlayed'))
# rank bots by openskill conservative rating, only those with >=40 matches
rank=sorted([b for b in byb if len(byb[b])>=40 and b in stats],key=lambda b:-(stats[b]['openskillMu']-3*stats[b]['openskillSigma']))
print('bots with >=40 matches:',len(rank))
hdr='rank bot  name                matches  score  tiles  paid/tile nwords avgLen n7+  endbal  tilesPlayed/won'
print(hdr)
def line(i,b):
    a=agg(b); nm=bots.get(b,{'name':'v?'+str(b)})['name'][:18]
    ppt=a['paid']/a['tiles'] if a['tiles'] else 0
    print(f"{i:3d} {b:>4} {nm:18s} {a['n']:6d} {a['score']:7.1f} {a['tiles']:5.1f} {ppt:7.1f} {a['nw']:6.1f} {a['avgL']:6.2f} {a['long7']:4.1f} {a['bal']:7.1f}  {a['played']/(a['tiles']+5):.2f}")
for i,b in enumerate(rank[:12],1): line(i,b)
print('...median bots')
mid=len(rank)//2
for i,b in enumerate(rank[mid-3:mid+3],mid-2): line(i,b)
print('...bottom')
for i,b in enumerate(rank[-4:],len(rank)-3): line(i,b)
# overall score distribution
allsc=[r['score'] for r in rows.values()]
print('overall score mean',round(st.mean(allsc),1),'median',st.median(allsc),'p90',sorted(allsc)[int(.9*len(allsc))],'max',max(allsc))

# price by round index within match
idx=collections.defaultdict(list)
byM=collections.defaultdict(list)
for r in d['auctionResult']:
    if r['matchId'] in ended: byM[r['matchId']].append(r)
import random
for m,rs in random.Random(1).sample(list(byM.items()),3000):
    rs.sort(key=lambda r:int(r['auctionId']))
    for i,r in enumerate(rs):
        if r.get('winnerBotId') not in (None,'None'): idx[i//10].append(int(r['paid']))
print('\nprice by round bucket (10 rounds each):')
for k in sorted(idx): print(f'  rounds {k*10:2d}-{k*10+9:2d}: median {st.median(idx[k]):.1f} mean {st.mean(idx[k]):.1f} n={len(idx[k])}')
print('rounds per match (auctions):',collections.Counter(len(v) for v in byM.values()).most_common(3))
# Bron: letter selectivity vs field
def letter_stats(botset):
    wins=collections.Counter(); tot=collections.Counter(); paid=collections.defaultdict(list)
    return wins,tot,paid
for who,name in [(114,'Bron'),(18,'LUCENT')]:
    wins=collections.Counter(); paid=collections.defaultdict(list)
    for r in d['auctionResult']:
        if r.get('winnerBotId')==str(who): wins[r['letter']]+=1; paid[r['letter']].append(int(r['paid']))
    nm=len([1 for k in rows if k[1]==str(who)]) or 1
    print(f'\n{name}: tiles won per match by letter (field avg in parens: n_total/(matches*6))')
    allc=collections.Counter(r['letter'] for r in d['auctionResult'] if r['matchId'] in ended)
    nmatch=len(ended)
    out=[]
    for L in 'ZXJQKYHFWMVCBPDGSLREAINOUT':
        field=allc[L]/nmatch/6
        out.append(f"{L}:{wins[L]/nm:.2f}({field:.2f}) ${st.mean(paid[L]) if paid[L] else 0:.0f}")
    print('  '+'  '.join(out))
