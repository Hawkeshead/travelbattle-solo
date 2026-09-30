"""Reference implementation of the v2 road overlay (Python, used to make the mockups).
Port the RULES and CONSTANTS to render-board.js; do not ship this file.
All positions are in CELL units on the assembled map, in SCREEN space (apply the
board flip before smoothing, so 'face centre' is always 0.469 down the cell on screen)."""
import math, numpy as np

FACE_CY = 0.469          # face centre sits 0.469 of a cell below the cell's top edge
EXIT_REACH = 1.1         # exit roads run 1.1 cells past the edge square's centre
DENSIFY = 12             # points per cell before smoothing
SMOOTH_ITERS = 90        # [0.25,0.5,0.25] passes, endpoints pinned
WOBBLE = [(0.045,2.1),(0.025,4.7),(0.012,9.3)]   # (amplitude cells, frequency per cell)
WOBBLE_RAMP = 0.45       # wobble fades to zero within 0.45 cell of each chain end
STROKES = [(0.26,(78,54,32,200)),(0.20,(132,98,60,255)),(0.12,(152,116,74,255))]  # width in cells, rgba; draw in order
RUTS = dict(offset=0.045, width=0.018, rgba=(110,80,48,150))                    # two thin lines either side of centre

D4 = [(0,-1),(0,1),(-1,0),(1,0)]

def build_graph(road_cells, isBuilding, inBounds, excluded):
    """road_cells: set of (x,y) ROAD squares. excluded: set of frozenset({(x1,y1),(x2,y2)}) from boardExcludedRoadEdges."""
    adj = {}
    def link(a,b): adj.setdefault(a,set()).add(b); adj.setdefault(b,set()).add(a)
    cells = sorted(road_cells); isRoad = lambda x,y: (x,y) in road_cells
    for (x,y) in cells:
        adj.setdefault(('c',x,y),set())
        for dx,dy in D4:
            n=(x+dx,y+dy)
            if isRoad(*n) and frozenset({(x,y),n}) not in excluded: link(('c',x,y),('c',*n))
    # RULE 1 villages: a road that dead-ends (<=1 link) beside a village runs into it,
    # then on to the nearest OTHER road square touching that village (if any).
    for (x,y) in cells:
        if len(adj[('c',x,y)])<=1:
            for dx,dy in D4:
                v=(x+dx,y+dy)
                if not isBuilding(*v): continue
                link(('c',x,y),('v',*v))
                others=[(v[0]+a,v[1]+b) for a,b in D4 if isRoad(v[0]+a,v[1]+b) and (v[0]+a,v[1]+b)!=(x,y)]
                if others:
                    o=min(others,key=lambda p:math.hypot(p[0]-x,p[1]-y)); link(('v',*v),('c',*o))
                break
    # RULE 2 map edge (assembled map, NOT board seams): a road square exits off the
    # edge only if it has fewer than two links on the map.
    for (x,y) in cells:
        if len(adj[('c',x,y)])<2:
            for dx,dy in D4:
                if not inBounds(x+dx,y+dy): link(('c',x,y),('e',x,y,dx,dy))
    return adj

def node_pos(n):
    if n[0]=='e': return (n[1]+.5+n[3]*EXIT_REACH, n[2]+FACE_CY+n[4]*EXIT_REACH)
    return (n[1]+.5, n[2]+FACE_CY)   # road squares and villages both use the face centre

def chains(adj):
    """Split the graph into runs between nodes whose degree is not 2 (ends, forks, exits)."""
    stop=lambda n:len(adj[n])!=2; seen=set(); out=[]
    for n in adj:
        if not stop(n): continue
        for m in adj[n]:
            if frozenset([n,m]) in seen: continue
            ch=[n,m]; seen.add(frozenset([n,m])); prev,cur=n,m
            while not stop(cur):
                nxt=[k for k in adj[cur] if k!=prev][0]; seen.add(frozenset([cur,nxt])); ch.append(nxt); prev,cur=cur,nxt
            out.append(ch)
    return out

def chain_seed(ch):
    """Stable per-chain seed from its two end nodes, so the wobble never changes between loads."""
    a,b=sorted([tuple(ch[0][1:3]),tuple(ch[-1][1:3])])
    return (a[0]*73856093 ^ a[1]*19349663 ^ b[0]*83492791 ^ b[1]*2654435761) % 1000003

def smooth_chain(ch):
    P=np.array([node_pos(n) for n in ch],float); pts=[P[0]]
    for a,b in zip(P[:-1],P[1:]):
        k=max(2,int(np.linalg.norm(b-a)*DENSIFY))
        for t in np.linspace(0,1,k+1)[1:]: pts.append(a+(b-a)*t)
    Q=np.array(pts)
    for _ in range(SMOOTH_ITERS): Q[1:-1]=0.25*Q[:-2]+0.5*Q[1:-1]+0.25*Q[2:]
    s=np.concatenate([[0],np.cumsum(np.linalg.norm(np.diff(Q,axis=0),axis=1))]); L=s[-1]
    if L>0.3:
        tan=np.gradient(Q,axis=0); tan/=np.linalg.norm(tan,axis=1)[:,None]+1e-9
        nrm=np.stack([-tan[:,1],tan[:,0]],1)
        rng=np.random.default_rng(chain_seed(ch)); ph=rng.uniform(0,2*math.pi,len(WOBBLE))
        off=sum(a*np.sin(s*f+p) for (a,f),p in zip(WOBBLE,ph))
        env=np.clip(np.minimum(s,L-s)/WOBBLE_RAMP,0,1)
        Q=Q+nrm*(off*env)[:,None]
    return Q
