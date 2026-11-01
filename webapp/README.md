# SimpleX names webapp

The store for SimpleX names on simplex.domains: search a name, pay by card, Bitcoin or Monero (or with a prepaid code), and register it on chain to a wallet made from the buyer's name code. It follows the design in simplex-chat `plans/names-codes/` (spec, sequence diagrams and mockups).

The page talks only to the names service under `/api`. In development that service is `dev/mock.ts`, which drives the real contracts on a local chain and reads names from them directly, as the service does over its Ethereum RPC.

## Layout

- `src/crypto/`: owner and prepaid codes, the wallet, the commitment and the signed messages, the sealed order.
- `src/flow.ts`: building an order, revealing it, another name or links after a failure, another name paid from an order's balance, finding a name code's order, link edits.
- `src/api.ts`, `src/store.ts`, `src/session.ts`: the service's API, what this browser keeps, and the tab's checkout and active prepaid code.
- `src/mode.ts`: the service's mode, `open` or `codes`, from `index.html`'s `simplex-names-mode` meta (see Codes only).
- `src/screens/`: each view's state and the reducer that moves it, with no clock, DOM, storage or network.
- `src/views/`: `shell.ts`, the frame between `index.html`'s header and its invest note and footer (`draw` puts a screen in, `kept` keeps a node a reader types into across redraws, `screen` and `outcome` build the two kinds of screen, `asStep` gives a screen the steps' frame); `chrome.ts`, the phone's menu and the header's active code; and the views: `search.ts` (the home), `checkout.ts` (the Links, name code, Community terms and Check your order steps), `order.ts` (payment, registration and every ending) and `names.ts` (Your names, Check your code and Edit links). `chats.ts` draws the chats a name opens, as the app's default pictures, and their popup after the app's connection alert; `links.ts` holds the link field that the Links step and Edit links share; `codes.ts` the code field of Check your code and of Check your order.
- `src/stripe.ts`: Stripe's Payment Element, mounted when the page carries a publishable key.
- `src/scan.ts` and `src/views/scan.ts`: a phone's camera reading a link's QR code into the Link field, by the browser's `BarcodeDetector` where it reads QR codes, otherwise by jsQR (Apache-2.0), which is served from the page's own origin and runs only when it first reads a frame; the service worker caches it with the rest of the build, so a page opened before a deploy still reads codes after it. The scan button shows only on a phone with a camera; a camera refused or missing says so, and Paste stays.
- `dev/`: the local chain deployment, the server of its terms' texts, the mock service and `start.sh`.
- `test/`: unit tests (vitest). `e2e/`: browser tests (Playwright) against the dev backend.

The window holds the header, the screen and the invest note; the footer is below the fold, as on the badges store. The purchase steps (search, Links, name code, Community terms for a community name, Check your order, payment) follow one another. Each step, and each screen like one (an order's outcome, Check your code, Edit links), is a frame of one height, 540 px on a laptop and 640 px on a phone, as the mockup draws it, so Back, the heading, the main button and the link under it stand at the same place on every step, for a name of any length; a step without a main button keeps its link at the link's place, and on a laptop a step's last link stays at least 48 px above the invest note. The content runs down from under the heading, so nothing above a change moves. The home keeps its answer's room from the start, so its headline and field never move. A plain name's order waits for its buyer to agree to the general terms on Check your order, whose words link the terms' page at the commit the name policy links; a community name's order waits for its buyer to accept its community terms, which include the general terms, on their own step, which shows their text as the service fetches it by the name policy's link and, for a link to git.simplex.chat, links that commit's page. While the terms of a name's kind cannot be read, its search answer says that names can't be ordered right now. A community name is registered for 2 years, even with a code for more, which Check your order then says. On Check your order, I have a code, under the payment choices, opens a code field in their place: a prepaid code that covers the name makes the order free, as the tab's code does, and Remove code, under the main button, brings the payment choices back. A pay page checks its name as it opens and every 5 minutes; when someone has registered it meanwhile, its note turns red and the payment's details are turned off. A prepaid code entered in Check your code registers the names the tab finds for free until it is taken off in the header; a name code entered there finds its order and adds it to Your names, or, reached from an order's page, opens the order it found. Every screen replaces the whole page between the header and the invest note and rises into place (220 ms); the old screen goes at once, so two never show together. What a step adds, such as a search's answer, a notice or a link's profile, fades in (180 ms); a change of theme eases its colours (200 ms). A reader who asks for reduced motion gets none of it.

## Run everything with Docker

From this directory, with Docker Compose:

```
docker compose up --build
```

The first build compiles the contracts (a few minutes). Each start deploys them to a fresh local chain, which takes about 2 minutes; the page is then on http://localhost:5173. The mock's controls are on http://localhost:8099/control/… (see below), the chain's RPC on http://localhost:8545 and the terms' texts, which the page links, on http://localhost:8098. `docker compose --profile prod up --build preview` serves the production build on http://localhost:4173.

Open the page on `localhost`: the browser gives its crypto API only to a secure context, which plain http on any other address is not.

With the stack up, the tests run from this directory as below, against the published ports.

## Setup

Node 24 runs the dev scripts' TypeScript directly.

```
npm install
npx playwright install chromium firefox webkit
```

The backend needs two things outside this repo:

1. The contracts: ens-contracts at PR #47 (6ccb5c5, whose name policy links the terms of each kind), the submodule of [simplex-namespace-contract](https://github.com/brenzi/simplex-namespace-contract) at its main (e3ba0a5, PR #10), whose `test/fixtures/terms/` holds the terms' texts, compiled:

   ```
   git clone https://github.com/brenzi/simplex-namespace-contract.git && cd simplex-namespace-contract
   git fetch origin e3ba0a50d9475dab8336b5a4026ab0fc5f79ebd4 && git checkout e3ba0a5
   git submodule update --init ens-contracts && cd ens-contracts
   npx pnpm@9 install --frozen-lockfile --ignore-scripts
   npx hardhat compile
   ```

2. Foundry's `anvil`, from the [release tarball](https://github.com/foundry-rs/foundry/releases). The backend runs on anvil only: Hardhat's node returns no revert data, which the mock needs to tell a taken name from a failure, so on it the balance, taken and contract browser tests fail. `start.sh` stops when a chain it waits for is not anvil, as when another chain already holds the port.

## Run

```
ENS_CONTRACTS_DIR=<ens-contracts> ANVIL=<anvil> MIN_COMMITMENT_AGE=10 dev/start.sh
npm run dev
```

`start.sh` starts anvil (one block a second) and `dev/serve-terms.ts`, which serves the files of `dev/terms/` (gitignored) on http://127.0.0.1:8098/terms/, each named by the sha256 of its bytes, so a link set earlier keeps its text. It deploys the contracts with `dev/deploy.ts`, seeds the price oracle with the launch prices ($100, $200 and $400 for 2 years at 8 or more, 7 and 6 letters), wires the name policy, which reserves `support`, `simplex` and `official`, links the namespace repository's `test/fixtures/terms/general-terms.md` and `community-terms.md`, written to `dev/terms/`, as its general terms and community terms, and lists the community names `bakers` and `bakehouse`, registers `bakery` (with links) and `harbour` (without) under the general terms and `bakehouse` (with links) under the community terms, which their holder accepts, then starts the mock on 127.0.0.1:8099. The deployment file records both links and their hashes. It prints three prepaid codes. The mock follows the store API contract (simplex-chat `plans/names-codes/2026-10-21-store-api.md`): it quotes prices from the oracle, starts every term on 1 January 2027, checks each order's owner signature and that each order and move signs the hash of the terms of its name's kind (after `community/` for a name on the name policy's community list), refusing it with `terms_unavailable` while their text cannot be fetched, that each reveal includes its owner's acceptance of those terms, which it relays to the name policy before the register, answers the text of either current terms, fetched by the name policy's link, at `/api/terms/<hash>`, which the page shows, and gives each invoice a Bitcoin regtest or Monero stagenet address. A link's profile, in a name's answer and a link's preview, is the app's: its kind (contact, channel, business or bot), names, picture and a channel's subscribers; the mock makes a contact link whose fragment starts with `Biz` a business, `Bot` a bot, `Pic` one with a picture, `Off` one whose host it does not fetch (an empty profile, `unavailable`), and a contact or channel link whose fragment starts with `Unr` one whose data could not be read now (an empty profile, `unread`). A link the chat core cannot parse, as `bakery`'s, whose keys do not decode as base64url, gets the `unavailable` empty profile too, and no deep link (`deepLink` null). Of the service's rate limits the mock keeps the code limit: 10 code checks and code orders a minute per client, a client being the last address in `X-Forwarded-For` (as the service with `trust_forwarded_for` takes it), else the connection's; the browser tests give each test an address of its own. Vite serves the page on http://127.0.0.1:5173 and proxies `/api` and `/control` to the mock.

`MIN_COMMITMENT_AGE` is the seconds a registration waits after its commit; the contracts' deploy scripts use 60.

Without a Stripe key the dev server shows a stand-in card form, labelled as a test, whose Pay button acts as a submitted card; the production build never has the stand-in, and shows that the card form did not load. The key goes in `index.html`'s `stripe-publishable-key` meta. To see Stripe's own form in development, put a test publishable key there (`pk_test_…`, from the Stripe dashboard in test mode) and keep it out of commits; the mock's client secrets are not Stripe's, so no card can be confirmed against it: that needs the service, with the account's test secret key (`sk_test_…`).

### Mock controls

Tests and manual checks move orders along with `POST` requests to the mock:

| Request | Effect |
|---|---|
| `/control/settle/<invoice>` `{"paid"}` | the money that reached the invoice is confirmed: its whole amount, or the coin given in `paid`. An open invoice is paid and registration starts, a balance it held is spent, and coin past the amount is credited to the order's balance; less than the amount is refused (`/control/partial` sends part). On a closed invoice the payment is late, as BTCPay keeps it: the invoice stays expired, with `paidInFull` once all of the amount arrived, the order stays unpaid, and each confirmed figure is credited to its balance once. Credit is the price's share of the coin, at the lower of the invoice's rate and the current one |
| `/control/partial/<invoice>` | half the crypto amount arrives |
| `/control/confirming/<invoice>` | the full amount is seen, not yet confirmed |
| `/control/expire/<invoice>` | the invoice expires |
| `/control/overdue/<invoice>` | the invoice's rate window ends now; the next request that meets it expires it, unless money reached it |
| `/control/fail/<registration>` | the next commit fails |
| `/control/lapse/<registration>` | a committed order not signed yet runs out of time for its reveal and fails |
| `/control/take` `{"label"}` | a rival registers the name before the waiting order; a paid order taken keeps its price as its balance |
| `/control/refund/<invoice or registration>` `{"cents"}` | support refunds the order's whole balance, the cents given or all of it, answering the refund and the orders whose balances paid it, or why not: `no_balance`, `balance_held` (with the holder and its invoice's expiry, overdue or not) or `balance_changed` |
| `/control/credit/<registration>` `{"cents"}` | the order's balance grows by the cents, as a later credit (a late payment, a cheaper move) grows it |
| `/control/late/<invoice>` `{"waiting"}` | a late payment's credit waits (`crediting`, `support`), as the view's `latePayment` then says; `null` lets it go, crediting what is confirmed |
| `/control/rate` `{"btc", "xmr"}` | the coin's current rate in whole dollars; a late payment is credited at the lower of it and its invoice's rate (`null` goes back to the invoice's) |
| `/control/search` `{"chainDown", "limitSeconds", "invoiceError", "findLimitSeconds", "unsentSeconds", "unreadSeconds", "writeDelayMs", "refuseLinks", "fetchDelays"}` | the chain cannot be read, search is rate limited, the next paid order, or the next spend from a balance at its invoice for the difference, is refused (`provider_unavailable`, `rate_limited` with a wait of `MOCK_RETRY_AFTER_SECONDS`, 30 s, `catalog_changed`, `internal`; `null` clears it), finding a code's orders is rate limited, no transaction goes out for that many seconds (each is tried again every `MOCK_RESEND_MS`, 5 s, up to `MOCK_RESENDS`, 12 times), the registration view's own chain reads fail for that many seconds (the view names them in `unread`), every write to a registration waits that long before its version check (to race two requests), the next reveal finds its links refused, or each fetch of a link's data, in a search or a preview, takes the milliseconds given for that link (`{link: ms}`, `{}` clears them; a profile that was read is kept 10 minutes and answered at once, as the service caches it, while one not read is fetched again) |
| `/control/general-terms` `{"text"}` or `{"link"}` | the owner sets the name policy's general terms to the link of this text, written to `dev/terms/`, to this link as it is, or back to the deployed link with a `null` text; an order or a move signing the old terms is refused with `terms_changed`, and the buyer of an order signed under them is asked to agree again before its reveal |
| `/control/community` `{"label", "for"}` | the name goes on the name policy's community list with what it is for, or comes off it with `null`; a registered name cannot be listed |
| `/control/community-terms` `{"text"}` or `{"link"}` | as `/control/general-terms`, for the community terms |
| `/control/edits` `{"limit"}` or `{"label", "count", "at"}` | the link edits a name gets in any 365 days, 1 to 100, as a restart with a new `[names] record_edits_per_year` would (3 at the start); or the name's counted edits, `count` of them made at `at` (unix seconds, now when left out), in place of those it has. As the service, a name with none left is refused with `429 {"error": "edit_limit", "nextAt"}` and its search answer's `recordEdits` says when the next one returns; an edit counts once it goes out, and an edit reverted on chain gives it back |
| `/control/code` `{"minLength", "years", "state"}` | issues a prepaid code |
| `/control/code/state` `{"code", "state"}` | sets a prepaid code's state, as an order elsewhere taking it or letting it go |
| `/control/mode` `{"mode"}` | `codes` refuses every name invoice and every balance spend with `403 {"error": "codes_only"}`, as the service with `[names] codes_only` on; `open`, the mock's mode at its start, takes them again. `GET /control/mode` answers it, and the dev server writes it into the page's `simplex-names-mode` meta, as the service does, or `open` when the mock does not answer |

`GET /control/state` dumps the mock's registrations, invoices and balances.

## Test

```
npm test          # unit tests
npm run build     # type check and production build into dist/
```

The browser tests run in parallel workers, each with a backend slot of its own: a chain, its deployment and a mock, as orders on one chain go one at a time. Start as many slots as workers, with a short commitment age, quick resends and a short injected rate limit; `start.sh` runs until stopped, so the tests run from another shell:

```
ulimit -c 0
SLOTS=3 MIN_COMMITMENT_AGE=5 MOCK_RESEND_MS=1000 MOCK_RETRY_AFTER_SECONDS=2 ENS_CONTRACTS_DIR=<ens-contracts> ANVIL=<anvil> dev/start.sh
SLOTS=3 npx playwright test
FIREFOX_158=<Firefox 158 executable> SLOTS=3 npx playwright test --project=firefox158
```

`ulimit -c 0`, in each shell, keeps a browser or chain that crashes from leaving a core file. Slot i has its chain on port 8545+i, its deployment in `dev/local-chain-i.json` and its mock on 8099+i; Playwright starts its page server on 5173+i, or uses one already there. `SLOTS` sets the workers too (4 by default; WebKit's at most 2, as its frames are drawn on the CPU); against a single backend, such as Docker Compose's, run with `SLOTS=1`. A slot takes about 1 GB of memory with its browser. A long run grows each chain's memory, so restart `start.sh` between full runs.

`npx playwright test` runs the `chromium`, `firefox` and `webkit` projects in one pool; `--project=chromium` (or `firefox`, `webkit`) runs one browser. Where memory is short, run the three one after another.

The tests run with reduced motion, so screens swap at once, except one test in `e2e/track.spec.ts`, which checks that each purchase step rises in, `e2e/frames.spec.ts`, which samples each frame of the swaps and fails on a near-empty one, and the tests in `e2e/motion.spec.ts` that check the motion itself: that it runs only for a reader who has not asked for less, that a swap never shows two screens at once, that a redraw replays nothing already shown, and that controls follow a switch of theme. `e2e/frames.spec.ts` runs in Chromium and, with `FIREFOX_158`, in Firefox 158: the `firefox158` project runs only this spec and exists only when `FIREFOX_158` names a Firefox 158 or later executable, launched through Playwright's `moz-firefox` channel with its own libraries. While `FIREFOX_158` is set, a plain `npx playwright test` runs `firefox158` too. The `firefox` and `webkit` projects skip it.

With `SHOTS=1` the tests write every screen they reach to `screenshots/` (or `SCREENSHOTS_DIR`), on a desktop and a phone, light and dark; Firefox's and WebKit's go to `screenshots/firefox/` and `screenshots/webkit/`, WebKit's in light only.

The service worker is in the production build only, so `e2e/offline.spec.ts` runs only against it and is skipped otherwise. `vite preview` sends the Content-Security-Policy given under Hosting, from its copy in `vite.config.ts`, and a test fails on any violation a page reports. With slot 0 of the backend up, serve the build, which proxies `/api` to slot 0's mock, and point the tests at it from another shell; they then run in one worker:

```
npm run build && npx vite preview --host 127.0.0.1
BASE_URL=http://127.0.0.1:4173 npx playwright test e2e/offline.spec.ts e2e/track.spec.ts
```

## Codes only

Until the full launch, names are registered only with prepaid codes. The page is the same build in both modes: `index.html` carries `<meta name="simplex-names-mode" content="open">`, whose content the service rewrites to `codes` while its `[names] codes_only` is on, and leaves `open` otherwise. In `codes` mode:

- The home's search field and its button are off, greyed with a not-allowed pointer, and take no focus or Enter, until the tab holds a prepaid code; one line says names can be registered with an investor code for now, and the screen's one action, Register with code, opens Check your code (`/#/code`).
- With a code, the search answers a name shorter than the code covers at once, without asking the service, and Check your order has no payment choices, no balance and no Pay with ETH: the tab's code pays, or, once it is taken off, a code entered in the field that takes the choices' place.
- Nothing offers a payment: a closed invoice offers no new one, a balance has no Use, and a balance the tab took before pays no more; refunds, Your names, restoring, link edits and order pages work as in `open` mode.
- The service answers `403 {"error": "codes_only"}` to `POST /api/invoice` for a name and to `POST /api/registration/:id/spend`. A page opened before the switch meets it: Check your order then says registration is by code only for now, and a closed invoice's page says so under its button, each with a way to enter a code.

## Hosting

`npm run build` writes a static site to `dist/`. The host it is served from needs:

- `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` (file names carry a content hash), `no-cache` on `index.html` and `/sw.js`, and a day or so on `/fonts/*` and `/img/*`; `no-store` on the service's `/api/*`.
- `/sw.js` served from the site's root, as JavaScript. It is the service worker `sw/plugin.ts` writes into the build: it keeps this build's shell and files in one cache per build, so the page and Your names open offline. The shell is network first, with a 3 s deadline and a check that it names this build's entry module; the build's files are cache first; `/api/*`, other origins and anything else go to the network untouched. The page registers it in the production build only, past the HTTP cache. To take it out, serve a `sw.js` whose install deletes every cache and calls `self.registration.unregister()`.
- Brotli or gzip for HTML, JS, CSS and `favicon.ico`.
- A 404 for unknown paths: the app's routes live in the hash and the query, never in the path.
- Security headers. `e2e/offline.spec.ts`, `e2e/track.spec.ts` and `e2e/paid.spec.ts` run with `BASE_URL` at `vite preview` report no violation in Chromium, Firefox and WebKit, without Stripe.js. Stripe.js loaded with a test key and a mock client secret mounts its frames with no violation in the three; a live Stripe key and 3-D Secure are still to be checked: `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-i5ar+ITNdQiucbmin4/AN6DAY5LbAWeq3at+RiFoUoY=' 'sha256-lxURZtAGLIPkeIfIfFjl4UIJp4ElJWSbFqE1ktKB8hk=' 'sha256-djvAKNENifE9sLU9+NrLdzdGftMgCwpvCvH/MAbkElY=' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (the hashes are index.html's inline theme, font preload and first frame scripts, and change with them), `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- Stripe.js runs on the page's own origin, which keeps the owner codes and prepaid codes in `localStorage`; the CSP admits scripts only from this origin and Stripe's script hosts, and the page loads Stripe.js only on the card screen. The owner accepted this on 2026-10-20, rather than a Checkout redirect or a separate card origin.
- The Stripe publishable key in `index.html`'s `stripe-publishable-key` meta. The service must create each PaymentIntent with `payment_method_types: ["card"]`: the page mounts the Payment Element with Apple Pay, Google Pay and Link off and keeps room for the card form alone, and a form that Stripe cannot load, or that has not loaded after 20 s, leads to the card-not-confirmed page.
- `/manifest.webmanifest` as `application/manifest+json`. With the service worker it makes the site installable as an app; its icons in `img/` are rendered from the SimpleX symbol by `node dev/app-icons.mjs ../img/simplex-symbol-light.svg ../img`.

## Not decided or not built

- The mock is a development fixture, not the service: it keeps everything in memory and moves no money.
