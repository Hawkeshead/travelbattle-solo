"""Reference implementation of the v2 farm field layout. Port the rules; do not ship.
cells = every PLOUGHED_FIELD square plus every FarmOverlay square (assembled map coords).
Returns {cell: farm tile index 0..3} -> farm_1..farm_4."""
def farm_fields(cells, h):   # h(x,y,salt) = the same integer hash used for other style picks
    seen=set(); out={}
    for c in sorted(cells,key=lambda p:(p[1],p[0])):
        if c in seen: continue
        # 1. flood-fill the contiguous block (4-neighbour)
        blk=[]; st=[c]; seen.add(c)
        while st:
            x,y=st.pop(); blk.append((x,y))
            for n in [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]:
                if n in cells and n not in seen: seen.add(n); st.append(n)
        B=set(blk); fid={}; fields=[]
        # 2. split each row-run into fields of 2 squares (a leftover single joins the last field -> 3);
        #    a lone square joins the field directly above it if there is one
        for y in sorted({p[1] for p in B}):
            xs=sorted(x for x,yy in B if yy==y); runs=[]; r=[xs[0]]
            for x in xs[1:]:
                if x==r[-1]+1: r.append(x)
                else: runs.append(r); r=[x]
            runs.append(r)
            for r in runs:
                if len(r)==1:
                    x=r[0]
                    if (x,y-1) in fid: j=fid[(x,y-1)]; fid[(x,y)]=j; fields[j].append((x,y)); continue
                    fields.append([(x,y)]); fid[(x,y)]=len(fields)-1; continue
                segs=[r[i:i+2] for i in range(0,len(r),2)]
                if len(segs[-1])==1 and len(segs)>1: last=segs.pop(); segs[-1]=segs[-1]+last
                for sg in segs:
                    fields.append([(x,y) for x in sg])
                    for x in sg: fid[(x,y)]=len(fields)-1
        # 3. a field that is still a single square joins the field directly below it
        for i,f in enumerate(fields):
            if len(f)==1:
                x,y=f[0]
                if (x,y+1) in fid and fid[(x,y+1)]!=i:
                    j=fid[(x,y+1)]; fields[j].append((x,y)); fid[(x,y)]=j; fields[i]=[]
        # 4. palette: blocks of 3+ squares use all four tiles; 1-2 square blocks keep one set
        #    (brown = farm_1 ploughed + farm_3 young crop, gold = farm_2 wheat + farm_4 hay)
        pal=[0,1,2,3] if len(B)>2 else [[0,2],[1,3]][h(blk[0][0],blk[0][1],9)%2]
        # 5. pick per field by hash, never matching an already-picked touching field
        tile={}
        for i,f in enumerate(fields):
            if not f: continue
            nb={tile[fid[n]] for (x,y) in f for n in [(x+1,y),(x-1,y),(x,y+1),(x,y-1)] if n in fid and fid[n] in tile and fid[n]!=i}
            opts=[t for t in pal if t not in nb] or pal
            tile[i]=opts[h(f[0][0],f[0][1],11)%len(opts)]
        for c2 in B: out[c2]=tile[fid[c2]]
    return out
# Drawing: mirror the farm image horizontally on squares where (x+y) is odd, so matching
# neighbours in a field never show as an exact clone.
