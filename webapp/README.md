# SimpleX names webapp

The store for SimpleX names on simplex.domains: search a name, pay by card, Bitcoin or Monero (or with a prepaid code), and register it on chain to a wallet made from the buyer's name code. It follows the design in simplex-chat `plans/names-codes/` (spec, sequence diagrams and mockups).

The page talks only to the names service under `/api`. In development that service is `dev/mock.ts`, which drives the real contracts on a local chain and reads names from them directly, as the service does over its Ethereum RPC.

## Layout

- `src/crypto/`: owner and prepaid codes, the wallet, the commitment and the signed messages, the sealed order.
- `src/flow.ts`: building an order, revealing it, another name or a code after `taken`, restore, link edits.
- `src/api.ts`, `src/store.ts`, `src/session.ts`: the service's API, what this browser keeps, and the tab's checkout.
- `src/views/`: search, checkout, the order page, Your names, restore and edit links.
- `src/stripe.ts`: Stripe's Payment Element, mounted when the page carries a publishable key.
- `dev/`: the local chain deployment, the mock service and `start.sh`.
- `test/`: unit tests (vitest). `e2e/`: browser tests (Playwright) against the dev backend.

## Run everything with Docker

From this directory, with Docker Compose:

```
docker compose up --build
```

The first build compiles the contracts (a few minutes). Each start deploys them to a fresh local chain, which takes about 2 minutes; the page is then on http://localhost:5173. The mock's controls are on http://localhost:8099/control/… (see below) and the chain's RPC on http://localhost:8545. `docker compose --profile prod up --build preview` serves the production build on http://localhost:4173.

Open the page on `localhost`: the browser gives its crypto API only to a secure context, which plain http on any other address is not.

With the stack up, the tests run from this directory as below, against the published ports.

## Setup

Node 24 runs the dev scripts' TypeScript directly.

```
npm install
npx playwright install chromium firefox
```

The backend needs two things outside this repo:

1. The contracts: ens-contracts at PR #36 (`ab/sponsor-sign-duration`), the submodule of [simplex-namespace-contract](https://github.com/brenzi/simplex-namespace-contract), compiled:

   ```
   git clone https://github.com/brenzi/simplex-namespace-contract.git && cd simplex-namespace-contract
   git submodule update --init ens-contracts && cd ens-contracts
   npx pnpm@9 install --frozen-lockfile --ignore-scripts
   npx hardhat compile
   ```

2. Foundry's `anvil`, from the [release tarball](https://github.com/foundry-rs/foundry/releases). Hardhat's own node does not return revert data, which the mock needs to tell a taken name from a failure.

## Run

```
ENS_CONTRACTS_DIR=<ens-contracts> ANVIL=<anvil> MIN_COMMITMENT_AGE=10 dev/start.sh
npm run dev
```

`start.sh` starts anvil (one block a second), deploys the contracts with `dev/deploy.ts`, registers `bakery` (with links) and `harbour` (without), reserves `support`, `simplex` and `official`, then starts the mock on 127.0.0.1:8099. It prints three prepaid codes. Vite serves the page on http://127.0.0.1:5173 and proxies `/api` and `/control` to the mock.

`MIN_COMMITMENT_AGE` is the seconds a registration waits after its commit; the contracts' deploy scripts use 60.

Without a Stripe key the dev server shows a stand-in card form whose Pay button acts as a submitted card; the production build shows that the card form did not load. The key goes in `index.html`'s `stripe-publishable-key` meta.

### Mock controls

Tests and manual checks move orders along with `POST` requests to the mock:

| Request | Effect |
|---|---|
| `/control/settle/<invoice>` | the invoice is paid; registration starts |
| `/control/partial/<invoice>` | half the crypto amount arrives |
| `/control/confirming/<invoice>` | the full amount is seen, not yet confirmed |
| `/control/expire/<invoice>` | the invoice expires |
| `/control/fail/<registration>` | the next commit fails |
| `/control/take` `{"label"}` | a rival registers the name before the waiting order |
| `/control/search` `{"chainDown", "limitSeconds", "invoiceError", "cancelStillOpen", "findLimitSeconds", "unsentSeconds"}` | the chain cannot be read, search is rate limited, the next order is refused (`provider_unavailable`, `rate_limited`, `catalog_changed`, `internal`; `null` clears it), the next cancel answers with the invoice still open, finding a code's orders is rate limited, or no transaction goes out for that many seconds (each is tried again every 5 s, for about a minute) |
| `/control/code` `{"minLength", "years", "state"}` | issues a prepaid code |
| `/control/code/state` `{"code", "state"}` | sets a prepaid code's state, as an order elsewhere taking it or letting it go |

`GET /control/state` dumps the mock's registrations and invoices.

## Test

```
npm test          # unit tests
npm run build     # type check and production build into dist/
npm run e2e       # browser tests; the backend must be running
```

The browser tests share one chain, so they run one at a time, and each order waits for its commit to age. They run in Chromium, Firefox and WebKit (`npm run e2e -- --project=firefox` for one). They run with reduced motion, as a reader who asks for less motion sees the page, so fading content is never matched twice; `e2e/motion.spec.ts` runs with motion and fails on any cut that `e2e/cuts.ts` records: content shown for a blink, content that appears or goes without easing, a height that jumps for a frame, a layout jump, a scroll jump, or a view transition the browser refused. A page opened or drawn again is the browser's own view transition, which `e2e/cuts.ts` also lists, with the parts it moved. They write every screen they reach to `screenshots/`, on a desktop and a phone, light and dark; Firefox's go to `screenshots/firefox/`. `BASE_URL=http://127.0.0.1:4173 npm run e2e` runs them against `npx vite preview` of the production build, and only then `e2e/offline.spec.ts`, as the service worker is in the production build only.

## Hosting

`npm run build` writes a static site to `dist/`. The host it is served from needs:

- `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` (file names carry a content hash), `no-cache` on `index.html` and `/sw.js`, and a day or so on `/fonts/*` and `/img/*`; `no-store` on the service's `/api/*`.
- `/sw.js` served from the site's root, as JavaScript. It is the service worker `sw/plugin.ts` writes into the build: it keeps this build's shell and files in one cache per build, so the page and Your names open offline. The shell is network first, with a 3 s deadline and a check that it names this build's entry module; the build's files are cache first; `/api/*`, other origins and anything else go to the network untouched. The page registers it in the production build only, past the HTTP cache. To take it out, serve a `sw.js` whose install deletes every cache and calls `self.registration.unregister()`.
- Brotli or gzip for HTML, JS, CSS and `favicon.ico`.
- A 404 for unknown paths: the app's routes live in the hash and the query, never in the path.
- Security headers. Checked against the built page with Stripe.js loaded (no violations), still to be checked with a live Stripe key and 3-D Secure: `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-Jhsw0wf9pI4icAxqab9mIjf34YdecDZeLVN+/KVZW+4=' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (the hash is index.html's inline theme script, and changes with it; with Stripe's Link on, also `https://link.com https://*.link.com` in `frame-src`, `connect-src` and `img-src`), `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- The Stripe publishable key in `index.html`'s `stripe-publishable-key` meta.
- `/manifest.webmanifest` as `application/manifest+json`. With the service worker it makes the site installable as an app; its icons in `img/` are rendered from the SimpleX symbol by `node dev/app-icons.mjs ../img/simplex-symbol-light.svg ../img`.

## Not decided or not built

- An order opened from the app needs the app's wallet to sign the registration. The page waits for it; the e2e test signs as the app would.
- The mock is a development fixture, not the service: it keeps everything in memory and moves no money.
