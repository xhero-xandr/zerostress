#!/usr/bin/env bash
# Mutation check of the artifact hand-over tests (spec 005, 3.6): break one protective step at a time in the server's
# copy of the sources and require that the Go tests fail. Run on the dev server, in the working copy to test. The sources
# are restored after every mutation and at exit. A mutation whose text is not found makes the run fail.
set -uo pipefail
export PATH=/opt/go/bin:$PATH
S=${SRC:-/opt/zerostress-src}
fails=0 total=0
backup=$(mktemp)
current=""
trap '[[ -n $current ]] && cp "$backup" "$S/$current"; rm -f "$backup"' EXIT

mut() { # file  sed-expression  directory  go-test-regex  label
  local file=$1 expr=$2 dir=$3 re=$4 label=$5
  total=$((total + 1))
  current=$file
  cp "$S/$file" "$backup"
  sed -i "$expr" "$S/$file"
  if cmp -s "$S/$file" "$backup"; then
    echo "NOT APPLIED: $label"; fails=$((fails + 1))
  elif (cd "$S/$dir" && go test -count=1 -run "$re" ./... >/tmp/zs-mut.log 2>&1); then
    echo "SURVIVED:    $label"; fails=$((fails + 1))
  elif grep -q -- '--- FAIL' /tmp/zs-mut.log; then
    echo "caught:      $label"
  else
    echo "BROKEN BUILD (not a catch): $label"; fails=$((fails + 1))
  fi
  cp "$backup" "$S/$file"
  current=""
}

mut supervisor/artifacts.go 's/if sum\[:16\] != m\[1\] {/if false {/' supervisor 'TestArtifact|TestPng|TestBinary' "hash check off"
mut supervisor/artifacts.go 's/if m\[2\] == "png" \&\& /if false \&\& /' supervisor 'TestPng' "png magic check off"
mut supervisor/run.go 's/^\tr.fetches.Wait().*/\t\/\/ removed/' supervisor 'TestFetchesFinish|TestArtifactIsFetched' "no wait for fetches before stopping the VM"
mut supervisor/run.go 's/r.artSeen\[name\] || b == nil/b == nil/' supervisor 'TestAnnouncedTwice' "dedupe off"
mut supervisor/run.go 's/r.artFiles >= s.cfg.MaxArtifacts || //' supervisor 'TestArtifactCountLimit' "count limit off"
mut supervisor/run.go 's/r.artBytes+need > s.cfg.MaxArtifactBytes/false/' supervisor 'TestArtifactTotalSize' "size limit off"
mut supervisor/run.go 's/!artifactNameRe.MatchString(name) || //' supervisor 'TestAnnouncementsThat' "name check off in the announcement"
mut supervisor/api.go 's/w.Header().Set("X-Content-Type-Options", "nosniff")//' supervisor 'TestArtifactIsServedWithSafeHeaders' "nosniff removed"
mut supervisor/vsock.go 's/if h.Bytes < 0 || h.Bytes > max {/if false {/' supervisor 'TestFetchOverTheWire' "size cap in fetch off"
mut guest/agent/artifact.go 's/syscall.O_NOFOLLOW|//' guest/agent 'TestArtifactRefusals' "O_NOFOLLOW off"
mut guest/agent/artifact.go 's/!st.Mode().IsRegular()/false/' guest/agent 'TestArtifactRefusals' "regular-file check off"
mut guest/agent/artifact.go 's/ok \&\& a.cred != nil \&\& sys.Uid != a.cred.Uid/ok \&\& false \&\& sys.Uid != 0/' guest/agent 'TestArtifactOfAnotherOwner' "owner check off"
mut guest/agent/artifact.go 's/if st.Size() > a.cfg.MaxArtifact {/if false {/' guest/agent 'TestArtifactRefusals' "size cap off"

echo "mutations: $total, problems: $fails"
exit $((fails > 0))
