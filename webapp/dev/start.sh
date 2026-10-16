#!/bin/bash
# Starts the local backend for the names webapp: a chain with the PR #36 contracts and the mock names service.
# Then run `npm run dev` for the page. Ctrl-C stops everything.
#
#   ENS_CONTRACTS_DIR  a compiled ens-contracts checkout at PR #36 (simplex-namespace-contract's submodule)
#   ANVIL              Foundry's anvil (default: anvil)
#   MIN_COMMITMENT_AGE seconds every registration waits after its commit (default: 60, as the PR's deploy scripts)
#   ANVIL_HOST         the address anvil listens on (default: 127.0.0.1)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ENS_CONTRACTS_DIR:?set ENS_CONTRACTS_DIR}"
ANVIL="${ANVIL:-anvil}"
export ENS_CONTRACTS_DIR MIN_COMMITMENT_AGE="${MIN_COMMITMENT_AGE:-60}"
RPC_PORT="${RPC_PORT:-8545}"
export RPC_URL="http://127.0.0.1:$RPC_PORT"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# One block a second, as a real chain moves on without transactions. Old states are dropped, not written to disk:
# anvil otherwise keeps every block's state under ~/.foundry, gigabytes an hour, and leaves it there if killed.
"$ANVIL" --chain-id 31337 --host "${ANVIL_HOST:-127.0.0.1}" --port "$RPC_PORT" --block-time 1 --prune-history --silent &
pids+=($!)
until curl -s -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' "$RPC_URL"; do sleep 0.2; done

node dev/deploy.ts

node dev/mock.ts &
pids+=($!)
wait
