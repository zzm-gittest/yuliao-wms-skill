#!/bin/bash
# yuliao-wms-skill installer (macOS / Linux)
# Double-click on macOS (or run in Terminal: bash install-macos.command)
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  yuliao-wms-skill installer for dsh"
echo "============================================"
echo
echo "This installs the WMS/ERP assistant plugins into your local"
echo "deepseek-harness (dsh) source checkout. Prerequisites:"
echo "  - dsh source cloned (github.com/deepseek-ai/deepseek-harness)"
echo "  - Node.js >= 24.9 and pnpm installed"
echo

read -rp "Enter the full path of your dsh repo (e.g. ~/idea-work/deepseek-harness): " DSH_DIR
DSH_DIR="${DSH_DIR/#\~/$HOME}"
DSH_DIR="${DSH_DIR%/}"

if [ ! -f "$DSH_DIR/pnpm-workspace.yaml" ] || [ ! -f "$DSH_DIR/packages/bundle/web-app/cordis.patch.yml" ]; then
  echo
  echo "[ERROR] \"$DSH_DIR\" does not look like a dsh repo."
  echo "Please clone deepseek-harness first, then re-run this installer."
  read -rp "Press Enter to close..."
  exit 1
fi

echo
echo "[1/5] Copying plugin packages..."
mkdir -p "$DSH_DIR/packages/experimental" "$DSH_DIR/overlays"
rm -rf "$DSH_DIR/packages/experimental/wms-ai" "$DSH_DIR/packages/experimental/wms-llm-bridge"
cp -R packages/wms-ai "$DSH_DIR/packages/experimental/wms-ai"
cp -R packages/wms-llm-bridge "$DSH_DIR/packages/experimental/wms-llm-bridge"
cp -f overlays/wms-dsh-bridge.yml "$DSH_DIR/overlays/"
echo "      OK"

echo "[2/5] Registering plugins (idempotent patch)..."
node patches/apply-wms-patch.mjs "$DSH_DIR"

echo "[3/5] pnpm install (may take a few minutes)..."
(cd "$DSH_DIR" && pnpm install)

echo "[4/5] Building wms-ai..."
(cd "$DSH_DIR" && node node_modules/typescript/bin/tsc -b packages/experimental/wms-ai)
(cd "$DSH_DIR/packages/experimental/wms-ai" && node ../../../node_modules/tsdown/dist/run.mjs)

echo "[5/5] Building wms-llm-bridge..."
(cd "$DSH_DIR" && node node_modules/typescript/bin/tsc -b packages/experimental/wms-llm-bridge)
(cd "$DSH_DIR/packages/experimental/wms-llm-bridge" && node ../../../node_modules/tsdown/dist/run.mjs)

echo
echo "============================================"
echo "  INSTALL SUCCESSFUL"
echo "============================================"
echo "Start dsh web with:"
echo "  cd $DSH_DIR"
echo "  pnpm dsh web --patch ./overlays/wms-dsh-bridge.yml"
echo "Then open the web UI and type /yuliao-wms in the chat box."
echo
read -rp "Press Enter to close..."
