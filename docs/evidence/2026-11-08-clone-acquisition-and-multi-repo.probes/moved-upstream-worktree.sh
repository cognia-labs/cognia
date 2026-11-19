#!/bin/bash
# S3: does a remote-supplied source checkout serve a worktree at a commit the
# mirror's backfill did not cover (the default branch after a refresh)? Before
# ADR-0176 A2 the supply backfilled only the derive commit, so this fails with
# "upload-pack: not our ref"; backfilling the served commit (D27) fixes it.
set -u
W=$(mktemp -d); cd "$W"
git init -q -b main origin; cd origin; git config user.email s@x; git config user.name s
mkdir -p app docs; echo a1 >app/a.ts; echo d1 >docs/d.md; git add -A; git commit -qm c1
git config uploadpack.allowFilter true; git config uploadpack.allowAnySHA1InWant true; cd "$W"
git clone -q --mirror --filter=blob:none "file://$W/origin" mirror
git -C mirror config uploadpack.allowFilter true; git -C mirror config uploadpack.allowAnySHA1InWant true
mkdir s1; GIT_INDEX_FILE="$W/i1" git --git-dir="$W/mirror" --work-tree="$W/s1" read-tree --reset -u HEAD   # materialize HEAD
git clone -q --no-hardlinks --filter=blob:none "file://$W/mirror" source                                   # derive source
echo "derive ok: $(ls source | tr '\n' ' ')"
# upstream moves on
cd origin; echo a2 >app/a.ts; echo d2 >docs/d.md; git commit -qam c2; C2=$(git rev-parse HEAD); cd "$W"
git -C mirror fetch -q --prune --prune-tags --filter=blob:none origin        # mirror refresh (fetch_args)
git -C source fetch -q --prune origin                                         # refresh_from_mirror
git -C source worktree add -q --detach "$W/wt" "$C2" 2>wt.err; echo "worktree add at the moved HEAD: exit=$? $(head -c 200 wt.err)"
ls "$W/wt" 2>/dev/null | tr '\n' ' '; echo
# with a backfill of C2 first
mkdir s2; GIT_INDEX_FILE="$W/i2" git --git-dir="$W/mirror" --work-tree="$W/s2" read-tree --reset -u "$C2"
rm -rf "$W/wt"; git -C source worktree prune
git -C source worktree add -q --detach "$W/wt" "$C2" 2>wt2.err; echo "after backfilling C2: exit=$? $(head -c 200 wt2.err) files: $(ls "$W/wt" | tr '\n' ' ')"
