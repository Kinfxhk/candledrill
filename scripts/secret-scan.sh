#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Secret scan. Preferred: gitleaks (https://github.com/gitleaks/gitleaks, MIT).
# Fallback when gitleaks is not installed: a conservative grep for common key formats.
# The fallback is weaker; CI always installs gitleaks.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if command -v gitleaks >/dev/null 2>&1; then
  echo "Running gitleaks $(gitleaks version) on git history..."
  gitleaks git --redact --no-banner --exit-code 1 .
  echo "Running gitleaks on working tree (untracked + uncommitted)..."
  gitleaks dir --redact --no-banner --exit-code 1 \
    --config .gitleaks.toml .
  echo "Secret scan passed (gitleaks)."
  exit 0
fi

echo "WARNING: gitleaks not found; using fallback pattern scan (less thorough)." >&2
PATTERNS=(
  'AKIA[0-9A-Z]{16}'                          # AWS access key id
  'gh[pousr]_[A-Za-z0-9]{36,}'                # GitHub tokens
  'github_pat_[A-Za-z0-9_]{50,}'              # GitHub fine-grained PAT
  'sk-[A-Za-z0-9_-]{20,}'                     # OpenAI/OpenRouter style keys
  'xox[baprs]-[A-Za-z0-9-]{10,}'              # Slack tokens
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'        # private keys
  'AIza[0-9A-Za-z_-]{35}'                     # Google API key
)
found=0
for p in "${PATTERNS[@]}"; do
  if git ls-files -co --exclude-standard -z | xargs -0 grep -nIE -e "$p" -- 2>/dev/null \
      | grep -v '^scripts/secret-scan.sh:'; then
    found=1
  fi
done
if [ "$found" -ne 0 ]; then
  echo "Secret scan FAILED (fallback)." >&2
  exit 1
fi
echo "Secret scan passed (fallback patterns)."
