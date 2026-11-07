import json,collections,statistics as st
d=json.load(open('bot/data/market-dump.json'))
T=lambda x: x['tag'] if isinstance(x,dict) else x
bots={b['id']:b for b in d['bot']}
sims={b['id'] for b in d['bot'] if b['isSimulated']}
ended={m['id'] for m in d['matchState'] if T(m['status'])=='Ended'}
tm={t['matchId'] for t in d['tournamentMatch']}
part=collections.defaultdict(list)
for p in d['matchParticipant']:
    if p['matchId'] in ended: part[p['matchId']].append(p)
nsim={m:sum(1 for p in ps if p['botId'] in sims) for m,ps in part.items()}
print('matches by number of sim bots:',sorted(collections.Counter(nsim.values()).items()))
real=[m for m in part if nsim[m]==0 and len(part[m])==6]
print('all-real 6-bot matches:',len(real),' tournament matches:',len(tm))
cls={'allreal':set(real),'tournament':{m for m in tm if m in part}}
res=collections.defaultdict(list)
for r in d['auctionResult']: res[r['matchId']].append(r)
for name,ms in cls.items():
    by=collections.defaultdict(list)
    for m in ms:
        for r in res[m]:
            if r.get('winnerBotId') not in (None,'None'): by[r['letter']].append(int(r['paid']))
    allp=[x for v in by.values() for x in v]
    print(f'\n== {name}: matches={len(ms)} overall paid median {st.median(allp):.1f} mean {st.mean(allp):.2f}')
    print('  '+'  '.join(f"{L}:{st.median(by[L]):.0f}" for L in 'ZXJQKYHFWMVCBPDGSLREAINOUT' if by[L]))
    sc=[int(p['score']) for m in ms for p in part[m]]
    print(f'  score mean {st.mean(sc):.1f} median {st.median(sc)} p90 {sorted(sc)[int(.9*len(sc))]} max {max(sc)}')
    # winner score distribution
    win=[max(int(p['score']) for p in part[m]) for m in ms]
    print(f'  winning score mean {st.mean(win):.1f} median {st.median(win)}  (2nd place mean {st.mean(sorted(int(p["score"]) for p in part[m])[-2] for m in ms):.1f})')
# bot performance only in all-real matches
perf=collections.defaultdict(list)
for m in real:
    ps=sorted(part[m],key=lambda p:-int(p['score']))
    for rank,p in enumerate(ps): perf[p['botId']].append((rank,int(p['score'])))
print('\nTop bots by mean place in ALL-REAL matches (>=100 matches):')
rows=[(st.mean(r for r,_ in v),st.mean(s for _,s in v),len(v),b) for b,v in perf.items() if len(v)>=100]
rows.sort()
for mp,ms_,n,b in rows[:10]: print(f"  {bots[b]['name'][:20]:20s} n={n:5d} mean place {mp+1:.2f} mean score {ms_:.1f} win% {100*sum(1 for r,_ in perf[b] if r==0)/n:.0f}")
print('  ... field (all bots, n>=100) mean place',round(st.mean(r for r,_,_,_ in [(a,0,0,0) for a,_,_,_ in rows])+1,2),' bots:',len(rows))
