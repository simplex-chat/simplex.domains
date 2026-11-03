#!/bin/bash
# Starts the local backend for the names webapp: a chain with the PR #47 contracts, the server of their terms' texts on
# 127.0.0.1:8098 and the mock names service. Then run `npm run dev` for the page. Ctrl-C stops everything.
#
#   ENS_CONTRACTS_DIR  the compiled ens-contracts submodule (PR #47) of a simplex-namespace-contract checkout, whose
#                      test/fixtures/terms/ the chain links as its terms
#   TERMS_HOST         the address the terms' texts are served on (default: 127.0.0.1)
#   ANVIL              Foundry's anvil (default: anvil)
#   MIN_COMMITMENT_AGE seconds every registration waits after its commit (default: 60, as the PR's deploy scripts)
#   ANVIL_HOST         the address anvil listens on (default: 127.0.0.1)
#   SLOTS              backends side by side, one per e2e worker: slot i has its chain on 8545+i, its deployment in
#                      dev/local-chain-i.json and its mock on 8099+i (default: one, in dev/local-chain.json)
#   MOCK_RESEND_MS     how often the mock tries again a transaction that did not go out (default: 5000)
#   MOCK_RESENDS       how many times it tries (default: 12)
#   MOCK_RETRY_AFTER_SECONDS  the wait the mock names for a rate limit injected with invoiceError (default: 30)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ENS_CONTRACTS_DIR:?set ENS_CONTRACTS_DIR}"
ANVIL="${ANVIL:-anvil}"
export ENS_CONTRACTS_DIR MIN_COMMITMENT_AGE="${MIN_COMMITMENT_AGE:-60}"
RPC_PORT="${RPC_PORT:-8545}"
MOCK_PORT="${MOCK_PORT:-8099}"
SLOTS="${SLOTS:-}"
count="${SLOTS:-1}"

# only jobs still running are stopped, so a PID reused since one ended is never killed
cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT INT TERM

rpc_url() { echo "http://127.0.0.1:$((RPC_PORT + $1))"; }
chain_file() { echo "dev/local-chain${SLOTS:+-$1}.json"; }

# One block a second, as a real chain moves on. Old states are dropped rather than kept under ~/.foundry, gigabytes an
# hour; a few stay in memory, as a call for the latest block fails with none while the next one is mined.
MEMORY_STATES=8
for ((i = 0; i < count; i++)); do
  "$ANVIL" --chain-id 31337 --host "${ANVIL_HOST:-127.0.0.1}" --port "$((RPC_PORT + i))" --block-time 1 --prune-history "$MEMORY_STATES" --silent &
done
rpc() { curl -s -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\"}" "$(rpc_url "$1")"; }
for ((i = 0; i < count; i++)); do
  until rpc "$i" eth_chainId >/dev/null; do sleep 0.2; done
  # a port another chain holds answers for it, and Hardhat's node returns no revert data, which the mock needs
  client="$(rpc "$i" web3_clientVersion)"
  if [[ "$client" != *'"anvil/'* ]]; then
    echo "$(rpc_url "$i") is not anvil: $client" >&2
    exit 1
  fi
done

node dev/serve-terms.ts &

deploys=()
for ((i = 0; i < count; i++)); do
  RPC_URL="$(rpc_url "$i")" LOCAL_CHAIN_OUT="$(chain_file "$i")" node dev/deploy.ts &
  deploys+=($!)
done
for pid in "${deploys[@]}"; do wait "$pid"; done

for ((i = 0; i < count; i++)); do
  MOCK_PORT="$((MOCK_PORT + i))" LOCAL_CHAIN_OUT="$(chain_file "$i")" node dev/mock.ts &
done
wait
