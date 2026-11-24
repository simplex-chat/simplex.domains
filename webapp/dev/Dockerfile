# syntax=docker/dockerfile:1
# The names webapp with its whole dev backend: a local chain with the PR #51 contracts and the mock names service.
# Built from the simplex.domains repository root, as compose.yaml does: the page's fonts and images live there.

FROM node:24-bookworm AS contracts
ARG ENS_CONTRACTS_COMMIT=ebf76989ec5cab1c7dd49085b4c18faf303657d0
WORKDIR /src/ens-contracts
RUN git clone https://github.com/simplex-network/ens-contracts.git . \
 && git fetch origin "$ENS_CONTRACTS_COMMIT" \
 && git checkout "$ENS_CONTRACTS_COMMIT"
RUN npx --yes pnpm@9 install --frozen-lockfile --ignore-scripts && npx hardhat compile

# Hardhat's own node answers reverts without their data, which the mock needs to tell a taken name from a failure
FROM debian:bookworm-slim AS anvil
ARG FOUNDRY_VERSION=v1.5.1
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz" \
  | tar -xz -C /usr/local/bin anvil

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=anvil /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=contracts /src/ens-contracts/artifacts /contracts/artifacts
WORKDIR /repo/webapp
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci
# public/ links to these, two levels up
COPY fonts /repo/fonts
COPY img /repo/img
COPY favicon.ico /repo/favicon.ico
COPY webapp /repo/webapp
ENV ENS_CONTRACTS_DIR=/contracts ANVIL=/usr/local/bin/anvil
