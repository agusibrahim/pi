#!/usr/bin/env bash
#
# Re-apply the Google Android AAS patch to a pi checkout.
#
# Designed to survive `git pull` and pi CLI updates:
#   * idempotent - a second run is a no-op
#   * all-or-nothing - `git apply --3way` is not atomic, so the three-way path
#     runs in a throwaway git worktree and only reaches your tree once every
#     file has merged
#   * refuses to run on a tree that already has unrelated edits to the files
#     the patch owns
#
#   ./apply.sh            apply the patch (no-op if already applied)
#   ./apply.sh --check    only report whether it would apply
#   ./apply.sh --verify   apply, then run the patch's tests
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/google-aas.patch"

# Default to the checkout that holds this script, so the repo works wherever it
# is cloned. PI_REPO overrides, which is what CI and a detached patch dir need.
# A hardcoded path here would silently target some other checkout.
REPO="${PI_REPO:-$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)}"
REPO="${REPO:-$SCRIPT_DIR/..}"

MODE="apply"
case "${1:-}" in
	--verify) MODE="verify" ;;
	--check) MODE="check" ;;
	"") ;;
	*) echo "usage: $(basename "$0") [--check|--verify]" >&2; exit 2 ;;
esac

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

run_tests() {
	echo
	echo "running patch tests..."
	cd "$REPO/packages/ai"
	node "$REPO/node_modules/vitest/dist/cli.js" --run test/google-oauth.test.ts test/google-oauth-bearer.test.ts
}

report_and_finish() {
	note ""
	note "next:"
	note "  cd $REPO"
	note "  npm install --ignore-scripts    # only if node_modules is stale"
	note "  npm run hydrate:model-data      # only if packages/ai/src/providers/data is missing"
	note "  npm run check"
	note "  ./test.sh"
	note ""
	note "then sign in with:  /login google"
	if [ "$MODE" = "verify" ]; then run_tests; fi
}

[ -f "$PATCH_FILE" ] || die "patch not found: $PATCH_FILE"
[ -d "$REPO/.git" ] || die "not a git repository: $REPO (override with PI_REPO=/path/to/pi)"

cd "$REPO"

# Split the patch's file list into paths it modifies and paths it creates.
# Classification is by presence in HEAD, not by numstat: a pure-addition hunk to
# an existing file also reports zero removals.
MODIFIED=()
CREATED=()
while IFS=$(printf '\t') read -r _added _removed path; do
	if git cat-file -e "HEAD:$path" 2>/dev/null; then
		MODIFIED+=("$path")
	else
		CREATED+=("$path")
	fi
done < <(git apply --numstat "$PATCH_FILE" 2>/dev/null || true)
[ "${#MODIFIED[@]}" -gt 0 ] || die "cannot read $PATCH_FILE; is it a valid git patch?"

PATCH_FILES=("${MODIFIED[@]}" "${CREATED[@]}")

note "repo    : $REPO"
note "patch   : $PATCH_FILE"
note "touches : ${#PATCH_FILES[@]} files (${#MODIFIED[@]} modified, ${#CREATED[@]} new)"

# Already-applied is checked first: an applied patch *is* a dirty tree, so the
# clobber guard below would otherwise reject every repeat run.
if git apply --reverse --check "$PATCH_FILE" 2>/dev/null; then
	note "state   : already applied, nothing to do"
	[ "$MODE" = "verify" ] && run_tests
	exit 0
fi

DIRTY="$(git status --porcelain -- "${PATCH_FILES[@]}")"
if [ -n "$DIRTY" ]; then
	printf 'error: these files already have uncommitted changes:\n%s\n' "$DIRTY" >&2
	die "commit or stash them first so the patch cannot clobber your work"
fi

# ---------------------------------------------------------------- fast path --
# A plain context apply is non-destructive: it either fully succeeds or does
# nothing. Try it first so the common case never needs a worktree.
if git apply --check "$PATCH_FILE" 2>/dev/null; then
	if [ "$MODE" = "check" ]; then
		note "state   : will apply cleanly"
		exit 0
	fi
	note "state   : not applied, applying (direct)"
	git apply "$PATCH_FILE"
	note "applied : clean (direct)"
	report_and_finish
	exit 0
fi

if [ "$MODE" = "check" ]; then
	note "state   : context moved upstream, needs a three-way merge"
	note "          run without --check to attempt it"
	exit 0
fi

# -------------------------------------------------------------- three-way ----
note "state   : context moved upstream, merging three-way in a scratch worktree"

SCRATCH="${TMPDIR:-/tmp}/pi-google-aas-apply.$$"
cleanup() {
	cd "$REPO" 2>/dev/null || true
	git worktree remove --force "$SCRATCH" >/dev/null 2>&1 || true
	rm -rf "$SCRATCH"
}
trap cleanup EXIT

git worktree add --detach --quiet "$SCRATCH" HEAD

if ! (cd "$SCRATCH" && git apply --3way "$PATCH_FILE" >/dev/null 2>&1); then
	note ""
	note "state   : CONFLICT"
	git worktree remove --force "$SCRATCH" >/dev/null 2>&1 || true
	trap - EXIT
	cat >&2 <<EOF

Your working tree is untouched. Upstream rewrote code the patch depends on, so
it cannot be merged automatically. Two behavioural changes are needed:

  1. packages/ai/src/providers/google.ts
     give the provider an auth.oauth alongside auth.apiKey, loaded from
     packages/ai/src/auth/oauth/google.ts. If that module already landed, only
     the oauth wiring plus its loader entry in auth/oauth/load.ts is missing.

  2. packages/ai/src/api/google-generative-ai.ts
     route auth through resolveRequestAuth() instead of requiring options.apiKey,
     so a caller-supplied Authorization header suppresses the SDK's
     x-goog-api-key header - which is what made valid OAuth tokens fail.

The three files this patch adds are also on disk, ready to copy:
  $SCRIPT_DIR/files/

EOF
	exit 1
fi

# Every file merged in the scratch worktree; now it is safe to touch the real one.
for path in "${MODIFIED[@]}"; do
	cp "$SCRATCH/$path" "$REPO/$path"
done
for path in "${CREATED[@]}"; do
	cp "$SCRATCH/$path" "$REPO/$path"
done
note "applied : clean (three-way)"

report_and_finish