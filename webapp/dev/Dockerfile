# syntax=docker/dockerfile:1
# The names webapp with its whole dev backend: a local chain with the PR #47 contracts and the mock names service.
# Built from the simplex.domains repository root, as compose.yaml does: the page's fonts and images live there.

FROM node:24-bookworm AS contracts
ARG NAMESPACE_COMMIT=e3ba0a50d9475dab8336b5a4026ab0fc5f79ebd4
ARG ENS_CONTRACTS_COMMIT=6ccb5c52c80619493db32a4128ee5067f4274ac2
WORKDIR /src
RUN git clone https://github.com/brenzi/simplex-namespace-contract.git . \
 && git fetch origin "$NAMESPACE_COMMIT" \
 && git checkout "$NAMESPACE_COMMIT" \
 && git submodule update --init ens-contracts \
 && git -C ens-contracts checkout "$ENS_CONTRACTS_COMMIT"
WORKDIR /src/ens-contracts
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
# the terms dev/deploy.ts links, beside ENS_CONTRACTS_DIR as in the namespace repository
COPY --from=contracts /src/test/fixtures/terms /test/fixtures/terms
WORKDIR /repo/webapp
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci
# public/ links to these, two levels up
COPY fonts /repo/fonts
COPY img /repo/img
COPY favicon.ico /repo/favicon.ico
COPY webapp /repo/webapp
ENV ENS_CONTRACTS_DIR=/contracts ANVIL=/usr/local/bin/anvil
