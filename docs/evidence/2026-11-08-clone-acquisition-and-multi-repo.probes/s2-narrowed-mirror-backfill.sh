#!/bin/bash
# S2: narrow the mirror backfill to the sparse cone, then check what a later
# full-tree derive from the same mirror does (and offline).
set -u
W=$(mktemp -d); cd "$W"
git init -q -b main origin; cd origin; git config user.email s@x; git config user.name s
mkdir -p app/src docs/big lib; echo a>app/src/a.ts; echo root>README.md; echo l>lib/l.ts
for i in $(seq 1 40); do head -c 2000 /dev/urandom | base64 > docs/big/f$i.txt; done
git add -A; git commit -qm c1; C=$(git rev-parse HEAD)
git config uploadpack.allowFilter true; git config uploadpack.allowAnySHA1InWant true
cd "$W"
git clone -q --mirror --filter=blob:none "file://$W/origin" mirror
git -C mirror config uploadpack.allowFilter true; git -C mirror config uploadpack.allowAnySHA1InWant true
missing() { git -C "$1" rev-list --objects --missing=print "$2" 2>/dev/null | grep -c '^?'; }
echo "mirror missing blobs before: $(missing mirror $C)"
# Narrowed backfill: the cone's blobs = files in cone dirs + files directly in
# root and in every ancestor of a cone dir (cone semantics). One batched fetch.
CONE=app
{ git -C mirror ls-tree -r "$C" -- "$CONE" | awk '$2=="blob"{print $3}'
  git -C mirror ls-tree "$C" | awk '$2=="blob"{print $3}'; } | sort -u > want.txt
echo "narrowed want: $(wc -l < want.txt) blobs"
git -C mirror -c fetch.negotiationAlgorithm=noop fetch -q origin --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin < want.txt 2> fetch.err; echo "narrowed fetch exit=$? $(head -c 200 fetch.err)"
echo "mirror missing blobs after narrowed: $(missing mirror $C)"
# 1. sparse derive of the cone from the mirror
git clone -q --no-hardlinks --filter=blob:none --no-checkout "file://$W/mirror" sparse
git -C sparse sparse-checkout set --cone "$CONE" 2>/dev/null
git -C sparse checkout -q main 2>sparse.err; echo "sparse derive checkout exit=$? $(head -c 300 sparse.err)"
ls sparse sparse/app 2>/dev/null | tr '\n' ' '; echo
# 2. later full-tree derive, no backfill
git clone -q --no-hardlinks --filter=blob:none "file://$W/mirror" full 2>full.err; echo "full derive exit=$? $(grep -m2 -i 'error\|fatal' full.err | head -c 300)"
echo "full checkout files: $(find full -path full/.git -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' ') (expected 43)"
git -C full status --porcelain 2>/dev/null | head -3
# 3. full backfill (today's materialize: read-tree -u into scratch), then derive
mkdir -p scratch; GIT_INDEX_FILE="$W/scratch.idx" git --git-dir="$W/mirror" --work-tree="$W/scratch" read-tree --reset -u "$C" 2>mat.err; echo "full materialize exit=$?"
echo "mirror missing after full: $(missing mirror $C)"
git clone -q --no-hardlinks --filter=blob:none "file://$W/mirror" full2 2>full2.err; echo "full derive after backfill exit=$? files: $(find full2 -path full2/.git -prune -o -type f -print | wc -l | tr -d ' ')"
# 4. offline: a fresh mirror, origin gone, narrowed backfill
git clone -q --mirror --filter=blob:none "file://$W/origin" mirror2; mv origin origin.gone
git -C mirror2 -c fetch.negotiationAlgorithm=noop fetch -q origin --no-tags --no-write-fetch-head --filter=blob:none --stdin < want.txt 2>off.err; echo "offline narrowed fetch exit=$? $(head -c 160 off.err)"
echo "workdir $W"
