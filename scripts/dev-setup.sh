#!/usr/bin/env bash
# One-shot local setup: install deps, create the signing key, hand the client its public key.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Server"
(cd server && npm install --no-audit --no-fund && node scripts/keygen.js)

echo "==> Client"
cp server/data/keys/public.pem client/config/public-key.pem
(cd client && npm install --no-audit --no-fund)

cat <<'EOF'

Ready. In two terminals:
  1) cd server && ADMIN_PASSWORD=choose-one npm start        # dashboard: http://localhost:8443/admin/
  2) cd client && npm run dev                                 # windowed dev mode (no kiosk lock)

Sign in with exam code DEMO101 (see server/config/exams.json).
EOF
