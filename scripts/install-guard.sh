#!/usr/bin/env bash
#
# install-guard.sh — install a local pre-commit guard for this checkout.
#
# The guard blocks two classes of accidental commits:
#   1. Data/secret files  (*.sqlite*, .env, *.bak)
#   2. Private content patterns listed in a gitignored .guard-denylist file
#      (your real institution names, wallet addresses, email, etc.)
#
# The hook lives in .git/hooks/ and is therefore NEVER committed, and the
# denylist is gitignored — so none of your private patterns enter the repo.
# Run this once per clone:  bash scripts/install-guard.sh
#
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
HOOK="$ROOT/.git/hooks/pre-commit"

cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# Local pre-commit guard (installed by scripts/install-guard.sh).
# Bypass deliberately with: git commit --no-verify
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
fail=0

# 1) Refuse to stage data-bearing / secret files.
blocked_files="$(git diff --cached --name-only --diff-filter=AM \
  | grep -E '(\.sqlite($|[-.])|(^|/)\.env($|\.)|\.bak$)' \
  | grep -vE '(\.env\.example$|\.example$)' || true)"
if [ -n "$blocked_files" ]; then
  echo "✖ pre-commit guard: refusing to commit data/secret files:" >&2
  printf '    %s\n' $blocked_files >&2
  fail=1
fi

# 2) Refuse staged content matching private patterns from .guard-denylist.
DENY="$ROOT/.guard-denylist"
if [ -f "$DENY" ]; then
  pat="$(grep -vE '^[[:space:]]*(#|$)' "$DENY" | sed 's/[[:space:]]*$//' | paste -sd'|' -)"
  if [ -n "$pat" ]; then
    hits="$(git diff --cached -U0 --diff-filter=AM \
      | grep -E '^\+' | grep -vE '^\+\+\+' \
      | grep -niE "$pat" || true)"
    if [ -n "$hits" ]; then
      echo "✖ pre-commit guard: staged changes contain private patterns (.guard-denylist):" >&2
      echo "$hits" | sed -E 's/^(.{110}).*/\1…/' >&2
      fail=1
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Commit blocked. Fix the above, or bypass with --no-verify if you are certain." >&2
  exit 1
fi
HOOK_EOF

chmod +x "$HOOK"
echo "Installed pre-commit guard → $HOOK"
if [ ! -f "$ROOT/.guard-denylist" ]; then
  cat >&2 <<MSG
Next: create $ROOT/.guard-denylist (gitignored) with one extended-regex per line
for the private strings this repo must never contain — e.g. your real institution
names (\\bAcme Bank\\b), wallet addresses (0xabc123), and email.
MSG
fi
