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
res=collections.defaultdict(list)
for r in d['auctionResult']:
    if r['matchId'] in real: res[r['matchId']].append(r)
for m in res: res[m].sort(key=lambda r:int(r['auctionId']))
closed={m:[float(r['closedAt']) for r in rs] for m,rs in res.items()}
import bisect
wp=collections.defaultdict(list)
for w in d['wordPlay']:
    if w['matchId'] in real: wp[(w['matchId'],w['botId'])].append(w)
top=['Waupus','Nijello','Chinese Dante','Lionel','Calebot','postturing','Lambi Lambiii']
name2id={b['name']:b['id'] for b in d['bot']}
topids={name2id[n] for n in top if n in name2id}
NB=7  # buckets of ~10 rounds
def prof(sel):
    tiles=[0]*NB; spend=[0]*NB; reward=[0]*NB; nwords=[0]*NB; cnt=0; cashbal=[0]*NB
    for m in real:
        rs=res[m]
        for p in part[m]:
            if not sel(p['botId']): continue
            cnt+=1
            bal=100
            ev=[]
            for i,r in enumerate(rs):
                if r.get('winnerBotId')==p['botId']: ev.append((float(r['closedAt']),'w',int(r['paid']),i))
            for w in wp.get((m,p['botId']),[]):
                # round index = number of auctions closed before playedAt
                i=bisect.bisect_right(closed[m],float(w['playedAt']))
                ev.append((float(w['playedAt']),'p',int(w['totalReward']),min(i,67)))
            ev.sort()
            for t,k,v,i in ev:
                b=min(i//10,NB-1)
                if k=='w': tiles[b]+=1; spend[b]+=v; bal-=v
                else: reward[b]+=v; nwords[b]+=1; bal+=v
            # balance at start of each bucket not tracked; skip
    f=lambda a:[round(x/cnt,2) for x in a]
    return cnt,f(tiles),f(spend),f(reward),f(nwords)
for label,sel in [('TOP7',lambda b:b in topids),('FIELD(others)',lambda b:b not in topids)]:
    cnt,t,s,r,n=prof(sel)
    print(f'\n{label} seats={cnt}')
    print(' rounds    ',[f'{i*10}-{i*10+9}' for i in range(NB)])
    print(' tiles won ',t,' total',round(sum(t),1))
    print(' coins spent',s,' total',round(sum(s),1))
    print(' reward    ',r,' total',round(sum(r),1))
    print(' words     ',n,' total',round(sum(n),1))
