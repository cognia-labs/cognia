#!/bin/bash
# S1: is "--no-checkout -> sparse -> checkout -> overlay" equivalent to
# "worktree add -> overlay -> sparse set"? Overlay = the snapshot's dirty
# entries written over the checkout, plus tracked paths removed from the
# working state deleted (apply_git_overlay).
set -u
git --version
W=$(mktemp -d); cd "$W"
git init -q -b main src && cd src
git config user.email s@x; git config user.name s
mkdir -p app/src docs lib; echo app >app/src/a.ts; echo docs >docs/d.md; echo lib >lib/l.ts; echo root >README.md
printf '#!/bin/sh\n' >app/run.sh; chmod +x app/run.sh
git add -A; git commit -qm base; BASE=$(git rev-parse HEAD)
# Working-state changes the overlay carries (the snapshot):
#  in cone:  modify app/src/a.ts, add app/new.ts, delete app/run.sh
#  outside:  modify docs/d.md, add docs/new.md, delete lib/l.ts
overlay() {
  local r=$1
  printf 'app-dirty\n' >"$r/app/src/a.ts"; printf 'new\n' >"$r/app/new.ts"; rm -f "$r/app/run.sh"
  mkdir -p "$r/docs"; printf 'docs-dirty\n' >"$r/docs/d.md"; printf 'docs-new\n' >"$r/docs/new.md"; rm -f "$r/lib/l.ts"
}
fingerprint() {
  local r=$1
  echo "-- files"; (cd "$r" && find . -path ./.git -prune -o \( -type f -o -type l \) -print | sort | while read f; do printf '%s %s %s\n' "$f" "$(stat -f %Lp "$f")" "$(shasum "$f" | cut -c1-8)"; done)
  echo "-- skip-worktree (S) / tracked"; git -C "$r" ls-files -v | sort
  echo "-- status"; git -C "$r" status --porcelain=v1 --untracked-files=all | sort
}
run_case() { # name base-ref sparse(0/1) overlay(0/1)
  local name=$1 ref=$2 sparse=$3 ov=$4
  local old="$W/old-$name" new="$W/new-$name"
  git -C "$W/src" worktree add -q --detach "$old" "$ref"
  [ "$ov" = 1 ] && overlay "$old"
  if [ "$sparse" = 1 ]; then git -C "$old" sparse-checkout init --cone 2>"$W/old-$name.err"; git -C "$old" sparse-checkout set app 2>>"$W/old-$name.err"; fi
  git -C "$W/src" worktree add -q --detach --no-checkout "$new" "$ref"
  if [ "$sparse" = 1 ]; then git -C "$new" sparse-checkout init --cone 2>/dev/null; git -C "$new" sparse-checkout set app 2>/dev/null; fi
  git -C "$new" checkout -q --detach "$ref" 2>"$W/new-$name.err" || git -C "$new" read-tree -mu HEAD
  [ "$ov" = 1 ] && overlay "$new"
  fingerprint "$old" >"$W/old-$name.fp"; fingerprint "$new" >"$W/new-$name.fp"
  if diff -q "$W/old-$name.fp" "$W/new-$name.fp" >/dev/null; then echo "SAME  $name"; else echo "DIFF  $name"; diff "$W/old-$name.fp" "$W/new-$name.fp" | sed 's/^/      /'; fi
  [ -s "$W/old-$name.err" ] && sed 's/^/      old stderr: /' "$W/old-$name.err"
}
run_case ref-nosparse "$BASE" 0 0
run_case ref-sparse   "$BASE" 1 0
run_case ws-nosparse  "$BASE" 0 1
run_case ws-sparse    "$BASE" 1 1
echo "workdir $W"
