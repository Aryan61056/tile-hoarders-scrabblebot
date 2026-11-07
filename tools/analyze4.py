import json,collections,statistics as st
d=json.load(open('bot/data/market-dump.json'))
T=lambda x: x['tag'] if isinstance(x,dict) else x
bots={b['id']:b for b in d['bot']}
sims={b['id'] for b in d['bot'] if b['isSimulated']}
ended={m['id'] for m in d['matchState'] if T(m['status'])=='Ended'}
part=collections.defaultdict(list)
for p in d['matchParticipant']:
    if p['matchId'] in ended: part[p['matchId']].append(p)
real={m for m,ps in part.items() if len(ps)==6 and not any(p['botId'] in sims for p in ps)}
won=collections.defaultdict(lambda:[0,0,0])
for r in d['auctionResult']:
    w=r.get('winnerBotId')
    if w in (None,'None') or r['matchId'] not in real: continue
    k=(r['matchId'],w); won[k][0]+=1; won[k][1]+=int(r['paid'])
words=collections.defaultdict(list)
for w in d['wordPlay']:
    if w['matchId'] in real: words[(w['matchId'],w['botId'])].append(w)
agg=collections.defaultdict(lambda:collections.defaultdict(list))
for m in real:
    for p in part[m]:
        k=(m,p['botId']); ws=words.get(k,[]); tw=won.get(k,[0,0,0])
        L=[len(x['word']) for x in ws]
        a=agg[p['botId']]
        a['score'].append(int(p['score'])); a['bal'].append(int(p['balance'])); a['tiles'].append(tw[0]); a['paid'].append(tw[1])
        a['nw'].append(len(ws)); a['avgL'].append(sum(L)/len(L) if L else 0); a['n7'].append(sum(1 for l in L if l>=7))
        a['maxL'].append(max(L) if L else 0); a['shortw'].append(sum(1 for l in L if l<=3))
        # timing of first word play relative to match start
        a['wordsby']; 
f=lambda a,k: st.mean(a[k])
print(f"{'bot':20s} {'n':>5} {'score':>6} {'tiles':>5} {'$/tile':>6} {'words':>5} {'avgL':>5} {'n7+':>4} {'<=3':>4} {'endbal':>6}")
rows=[(st.mean(1 if False else 0 for _ in [0]),b) for b in agg]
order=sorted([b for b in agg if len(agg[b]['score'])>=100],key=lambda b:-st.mean(agg[b]['score']))
for b in order[:8]+order[len(order)//2-2:len(order)//2+2]+order[-3:]:
    a=agg[b]; t=f(a,'tiles'); 
    print(f"{bots[b]['name'][:20]:20s} {len(a['score']):5d} {f(a,'score'):6.1f} {t:5.1f} {f(a,'paid')/max(t,1e-9):6.1f} {f(a,'nw'):5.1f} {f(a,'avgL'):5.2f} {f(a,'n7'):4.1f} {f(a,'shortw'):4.1f} {f(a,'bal'):6.1f}")
# field-wide
allsc=[x for b in agg for x in agg[b]['score']]
print('field tiles/bot',round(st.mean(x for b in agg for x in agg[b]['tiles']),2),'words/bot',round(st.mean(x for b in agg for x in agg[b]['nw']),2),'n7+/bot',round(st.mean(x for b in agg for x in agg[b]['n7']),2))
# score vs tiles relationship (all real bot-matches)
by=collections.defaultdict(list)
for b in agg:
    for t,s in zip(agg[b]['tiles'],agg[b]['score']): by[t].append(s)
print('tiles won -> mean score:',' '.join(f"{t}:{st.mean(by[t]):.0f}" for t in sorted(by) if len(by[t])>200 and t<=26))
# word length distribution field-wide
Lc=collections.Counter(len(w['word']) for ws in words.values() for w in ws)
tot=sum(Lc.values()); print('word length dist %:',' '.join(f"{l}:{100*Lc[l]/tot:.0f}" for l in sorted(Lc) if l<=11))
