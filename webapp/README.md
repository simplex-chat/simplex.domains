# SimpleX names webapp

The store for SimpleX names on simplex.domains: search a name, pay by card, Bitcoin or Monero (or with a prepaid code), and register it on chain to a wallet made from the buyer's name code. It follows the design in simplex-chat `plans/names-codes/` (spec, sequence diagrams and mockups).

The page talks only to the names service's `/api`, at `SITE.apiOrigin`, and to the card page it frames for a card payment. In development that service is `dev/mock.ts`, which drives the real contracts on a local chain and reads names from them directly, as the service does over its Ethereum RPC.

## Layout

- `src/crypto/`: owner and prepaid codes, the wallet, the commitment and the signed messages, the sealed order, the payment addresses' proofs.
- `src/flow.ts`: building an order, revealing it, a name selected for an order whose name was taken first, finding a name code's order, link edits.
- `src/api.ts`, `src/store.ts`, `src/session.ts`: the service's API, what this browser keeps, and the tab's checkout and active prepaid code.
- `src/config.ts`: the deployment the page holds, `SITE`: the chain, the contracts, the TLD, the term's start, the paid and community years, the years a code may give, the prices and their currency, the terms, the keys payments go to (Bitcoin receiving keys and Monero primary addresses, with their networks' prefixes) and the mode, `open` or `codes` (`src/mode.ts`, see Codes only). A production build holds `MAINNET` alone; any other build and the dev server hold `LOCAL`, the dev chain's, which `dev/deploy.ts` checks its deployment against and takes its prices from. The page signs and draws with these values, whatever the service answers. It offers a name for an order only when its search answer has these terms of the name's kind and these years and, unless a code registers it, this price; it signs an order or a reveal only for this name policy and the terms the buyer agreed to, which are these terms, and a reveal only for the order's own term; it takes a code only for these years, and a refusal for changed terms or a changed price only with these terms or this price. From `GET /api/config` it reads only the service's downtime, before it draws, for at most 5 seconds; `index.html` preloads it while the modules load.
- `src/screens/`: each view's state and the reducer that moves it, with no clock, DOM, storage or network.
- `src/views/`: `shell.ts`, the frame between `index.html`'s header and its invest note and footer (`draw` puts a screen in, `kept` keeps a node a reader types into across redraws, `screen` and `outcome` build the two kinds of screen, `asStep` gives a screen the steps' frame); `chrome.ts`, the phone's menu and the header's active code; and the views: `search.ts` (the home), `checkout.ts` (the Links, name code, Community terms and Check your order steps), `order.ts` (payment, registration and every ending) and `names.ts` (Your names, Check your code and Edit links). `chats.ts` draws the chats a name opens, as the app's default pictures, and their popup after the app's connection alert; `links.ts` holds the link field that the Links step and Edit links share; `codes.ts` the code field of Check your code and of Check your order.
- `src/stripe.ts`, `card/` and `src/card-frame.ts`: Stripe's Payment Element, mounted by the card page on its own origin after its PaymentIntent check, and the frame the order's page holds it in.
- `src/scan.ts` and `src/views/scan.ts`: a phone's camera reading a link's QR code into the Link field, by the browser's `BarcodeDetector` where it reads QR codes, otherwise by jsQR (Apache-2.0), which is served from the page's own origin and runs only when it first reads a frame; the service worker caches it with the rest of the build, so a page opened before a deploy still reads codes after it. The scan button shows only on a phone with a camera; a camera refused or missing says so, and Paste stays.
- `dev/`: the local chain deployment, the server of its terms' texts, the mock service, `start.sh`, and `check-mainnet.ts`, which compares `MAINNET` with the chain (Hosting).
- `test/`: unit tests (vitest). `e2e/`: browser tests (Playwright) against the dev backend.

The window holds the header, the screen and the invest note; the footer is below the fold, as on the badges store. The purchase steps (search, Links, name code, Community terms for a community name, Check your order, payment) follow one another. Each step, and each screen like one (an order's outcome, Check your code, Edit links), is a frame of one height, 540 px on a laptop and 640 px on a phone, as the mockup draws it, so Back, the heading, the main button and the link under it stand at the same place on every step, for a name of any length; a step without a main button keeps its link at the link's place, and on a laptop a step's last link stays at least 48 px above the invest note. The content runs down from under the heading, so nothing above a change moves. The home keeps its answer's room from the start, so its headline and field never move. A plain name's order waits for its buyer to agree to the general terms on Check your order, whose words link the terms' page at the commit the name policy links; a community name's order waits for its buyer to accept its community terms, which include the general terms, on their own step, which shows their text as the service fetches it by the name policy's link and, for a link to git.simplex.chat or GitHub, links that commit's page. While the terms of a name's kind cannot be read, its search answer says that names can't be ordered right now. A community name is registered for 2 years, even with a code for more, which Check your order then says. On Check your order, I have a code, under the payment choices, opens a code field in their place: a prepaid code that covers the name makes the order free, as the tab's code does, and Remove code, under the main button, brings the payment choices back. A pay page checks its name as it opens and every 5 minutes; when someone has registered it meanwhile, its note turns red and the payment's details are turned off. The page signs each order's registration over the dispute days of its payment, by its own table: 120 for a card, and 14 for Bitcoin, Monero or a prepaid code. An order is signed so when it is placed, a closed order's new invoice over the days of that invoice's payment, and a name selected for a taken order over the days of the order's payment. A registration signed again later, by the order's page or by Continue, is signed over the days of the payment in this browser's record of the order. A record is given the payment asked for, which the order seals beside its name and links, so an order reopened with its code, in this browser or another, keeps it; for an order sealed before its payment was, a record made in this browser keeps its own, and one of another browser takes the payment the service reported. The order seals the terms its buyer agreed to too, which an order reopened in another browser signs; one sealed before its terms were takes the terms the service reports. An open invoice of another payment than its order asked for, of another amount than the price the page holds for its name, in another currency than dollars, or to an address that its proof does not derive from the page's keys (`src/crypto/payees.ts`: a Bitcoin address from one of `SITE.bitcoinReceiveKeys` and the invoice's key tweak, a Monero subaddress from one of `SITE.moneroPrimaryAddresses`, its spend tweak and a proof that its view key is the wallet's), or to an address other than the one the order's record keeps for it, is drawn without its payment details, saying that they could not be checked. The record keeps each invoice's address and address proof as the service first sent them; beside the reference line of every screen of an order's page, and in its refund, Copy for support copies the reference of an invoice paid to an address and that proof; the payment screen shows the reference in its payment card alone. A record restored with the name code takes the invoice's address and proof as the service gives them then. A service that expects other days refuses the signature: Check your order then says that the order or the selection did not go through, a closed order's page says so of its new invoice, the order's page says, after three refusals, that the name could not be signed, and Continue says that it did not go through. Continue on an order whose terms of the name's kind changed since it was placed asks its buyer to accept them first, as the order's page does before a reveal. Once the order is ended in the service's view, which the service sets at its hourly check of the chain, or at its check of a mined register when the name was unregistered before the register was confirmed, the order's page says so: at once while it follows the registration, and when it is next opened once it has stopped reading a registered order. Your names marks its row Ended, and Edit links says that the registration was ended. Until that check, Your names shows a name unregistered on chain with its expiry date and the Name code button alone, and Edit links says that the name could not be read now and reads it again every 5 seconds. A prepaid code entered in Check your code registers the names the tab finds for free until it is taken off in the header; a name code entered there finds its order and adds it to Your names, or, reached from an order's page, opens the order it found. The name address, the checksummed address of the name code's wallet, which the buyer sends with support requests, stands beside the name code wherever it is shown: on the name code step, in Check your code, and, with a link to Etherscan's page of the registrar's tokens it holds, under "Registered until …" on the registered order's page, with the code hidden, and in a registered row's name code in Your names. On a phone, the registered order's page grows past the window under a name of more than about 25 letters. Every screen replaces the whole page between the header and the invest note and rises into place (220 ms); the old screen goes at once, so two never show together. What a step adds, such as a search's answer, a notice or a link's profile, fades in (180 ms); a change of theme eases its colours (200 ms). A reader who asks for reduced motion gets none of it.

## Run everything with Docker

From this directory, with Docker Compose:

```
docker compose up --build
```

The first build compiles the contracts (a few minutes). Each start deploys them to a fresh local chain, which takes about 2 minutes; the page is then on http://localhost:5173. The mock's controls are on http://localhost:8099/control/… (see below), the chain's RPC on http://localhost:8545 and the terms' texts, which the page links, on http://localhost:8098. `docker compose --profile prod up --build preview` serves a build for the dev chain, `vite build --mode devchain`, on http://localhost:4173.

Open the page on `localhost`: the browser gives its crypto API only to a secure context, which plain http on any other address is not.

With the stack up, the tests run from this directory as below, against the published ports.

## Setup

Node 24 runs the dev scripts' TypeScript directly.

```
npm install
npx playwright install chromium firefox webkit
```

The backend needs two things outside this repo:

1. The contracts: ens-contracts at ebf7698 (PR #51, in which each sponsored registration has a dispute period), the submodule of [simplex-namespace-contract](https://github.com/brenzi/simplex-namespace-contract) at its main (e3ba0a5, PR #10), whose `test/fixtures/terms/` holds the terms' texts, compiled:

   ```
   git clone https://github.com/brenzi/simplex-namespace-contract.git && cd simplex-namespace-contract
   git fetch origin e3ba0a50d9475dab8336b5a4026ab0fc5f79ebd4 && git checkout e3ba0a5
   git submodule update --init ens-contracts && cd ens-contracts
   git checkout ebf7698
   npx pnpm@9 install --frozen-lockfile --ignore-scripts
   npx hardhat compile
   ```

2. Foundry's `anvil`, from the [release tarball](https://github.com/foundry-rs/foundry/releases). The backend runs on anvil only: Hardhat's node returns no revert data, which the mock needs to tell a taken name from a failure, so on it the balance, taken and contract browser tests fail. `start.sh` stops when a chain it waits for is not anvil, as when another chain already holds the port.

## Run

```
ENS_CONTRACTS_DIR=<ens-contracts> ANVIL=<anvil> MIN_COMMITMENT_AGE=10 dev/start.sh
npm run dev
```

`start.sh` starts anvil (one block a second) and `dev/serve-terms.ts`, which serves the files of `dev/terms/` (gitignored) on http://127.0.0.1:8098/terms/, each named by the sha256 of its bytes, so a link set earlier keeps its text. It deploys the contracts with `dev/deploy.ts`, seeds the price oracle with the launch prices ($100, $200 and $400 for 2 years at 8 or more, 7 and 6 letters), wires the name policy, which reserves `support`, `simplex` and `official`, links the namespace repository's `test/fixtures/terms/general-terms.md` and `community-terms.md`, written to `dev/terms/`, as its general terms and community terms, and lists the community names `bakers` and `bakehouse`, registers `bakery` (with links) and `harbour` (without) under the general terms and `bakehouse` (with links) under the community terms, which their holder accepts, then starts the mock on 127.0.0.1:8099. The deployment file records both links and their hashes. It prints three prepaid codes. The mock follows the store API contract (simplex-chat `plans/names-codes/2026-10-21-store-api.md`): it quotes prices from the oracle, starts every term on 1 January 2027, checks each order's owner signature and that each order and each selection of a name signs the hash of the terms of its name's kind (after `community/` for a name on the name policy's community list), refusing it with `terms_unavailable` while their text cannot be fetched, that each reveal includes its owner's acceptance of those terms, which it relays to the name policy before the register, answers the text of either current terms, fetched by the name policy's link, at `/api/terms/<hash>`, which the page shows, and gives each invoice a Bitcoin regtest address or a Monero stagenet subaddress, at an index drawn from the invoice's id, with its address proof, from the dev keys of the store service's recorded fixtures, which `LOCAL` holds (`dev/mock/addresses.ts`). A link's data, in a name's answer and a link's preview, is the service's: its type and read state, and of a profile read its names and picture, an address's peer type and business flag, and a channel's group type and member count, from which the page tells the app's kinds (contact, channel, business or bot) and a channel's subscribers; the mock makes a contact link whose fragment starts with `Biz` a business, `Bot` a bot, `Pic` one with a picture, `Off` one whose host it does not fetch (no profile, `unavailable`), and a contact or channel link whose fragment starts with `Unr` one whose data could not be read now (no profile, `unread`). A link the chat core cannot parse, as one whose key does not decode as base64url and encode back to itself, or a `simplex:/` link without `h`, is refused with `invalid_link` and left out of a name's answer. Of the service's rate limits the mock keeps the code limit: 10 code checks and code orders a minute per client, a client being the last address in `X-Forwarded-For` (as the service with `trust_forwarded_for` takes it), else the connection's; the browser tests give each test an address of its own. Vite serves the page on http://127.0.0.1:5173 and proxies `/api` and `/control` to the mock.

`MIN_COMMITMENT_AGE` is the seconds a registration waits after its commit; the contracts' deploy scripts use 60.

`dev/deploy.ts` stops with an error when the chain id, the TLD, an address or a terms link it deploys differs from `LOCAL` in `src/config.ts`, as the page signs over `LOCAL`'s values. The anvil accounts deploy the contracts in a fixed order, so each fresh chain has the same addresses.

Each order's view in the mock contains the dispute days of its payment, 120 for a card and 14 for Bitcoin, Monero or a prepaid code, over which the mock checks the order's signed registration; for a name selected for a taken order, they are those of the order's payment. Once the name is registered, the view's `registered` phase contains the registrar's dispute end.

The card form is the card page's, `card/`, on its own origin, `SITE.cardOrigin` (`http://127.0.0.1:5180` in development, `npm run dev:card`; Playwright and Docker Compose start it), which the order's page frames, so Stripe.js never runs beside the names codes' storage. The two pages talk by `postMessage`, each taking messages only from the other's origin and frame: the order's page sends `mount` (the client secret, the invoice's amount, the theme), `theme` and `confirm`; the card page answers `mounted`, `height`, `paid`, `invalid`, `declined` and `failed`. Before it mounts Stripe's form, the card page reads the PaymentIntent with its own key, `SITE.stripeKey`, and mounts nothing unless the intent has the invoice's amount, dollars, the key's mode (`SITE.stripeLive`) and the card alone; the order's page then withholds the payment's details, saying that they could not be checked. Without a Stripe key the card page's development server shows a stand-in card form, labelled as a test, whose Pay button acts as a submitted card; a production build never has the stand-in, and shows that the card form did not load. To see Stripe's own form in development, start the card page with `VITE_STRIPE_KEY` set to a test publishable key (`pk_test_…`, from the Stripe dashboard in test mode); the browser tests give the card page `pk_test_e2e` in `window.stripeTestKey`, which no production build reads. The mock's client secrets are not Stripe's, so no card can be confirmed against it: that needs the service, with the account's test secret key (`sk_test_…`). `npm run build:card` builds the card page into `dist-card/`, which its own repository deploys to `pay.simplex.domains`.

### Mock controls

Tests and manual checks advance orders with `POST` requests to the mock:

| Request | Effect |
|---|---|
| `/control/settle/<invoice>` `{"paid"}` | the money that reached the invoice is confirmed: its whole amount, or the coin given in `paid`. An open invoice is paid and registration starts, and coin past the amount is credited to the order's balance; while another paid order holds the name, the order is taken instead and its price credited, as the service does; less than the amount is refused (`/control/partial` sends part). On a closed invoice the payment is late, as BTCPay keeps it: the invoice stays expired, with `paidInFull` once all of the amount arrived, the order stays unpaid, and each confirmed figure is credited to its balance once. Credit is the price's share of the coin, at the lower of the invoice's rate and the current one |
| `/control/partial/<invoice>` | half the crypto amount arrives |
| `/control/confirming/<invoice>` | the full amount is seen, not yet confirmed |
| `/control/expire/<invoice>` | the invoice expires |
| `/control/overdue/<invoice>` | the invoice's rate window ends now; the next request that meets it expires it, unless money reached it |
| `/control/fail/<registration>` | the next commit fails |
| `/control/lapse/<registration>` | a committed order not signed yet runs out of time for its reveal and fails |
| `/control/unregister/<registration>` | the contracts' owner unregisters a registered order's name in its dispute period, as the guardian or the admin does for a disputed, reversed or refunded payment: the name is available to anyone at once, and the order is `ended` from then on |
| `/control/take` `{"label"}` | a rival registers the name before the waiting order, whose name is then not selected: a paid order keeps its price as its balance, and a code order keeps its code reserved, until a name is selected for the order, with a new order's checks, and paid from the balance or registered with the code; the code is accepted past its expiry until a calendar month after the take, and refused once revoked |
| `/control/refund/<invoice or registration>` `{"cents"}` | support refunds the order's whole balance, the cents given or all of it, answering the refund, or why not: `no_balance` or `balance_changed` |
| `/control/credit/<registration>` `{"cents"}` | the order's balance grows by the cents, as a later credit (a late payment) grows it |
| `/control/late/<invoice>` `{"waiting"}` | a late payment's credit waits (`crediting`, `support`), as the view's `latePayment` then says; `null` lets it go, crediting what is confirmed |
| `/control/rate` `{"btc", "xmr"}` | the coin's current rate in whole dollars; a late payment is credited at the lower of it and its invoice's rate (`null` goes back to the invoice's) |
| `/control/search` `{"chainDown", "limitSeconds", "invoiceError", "findLimitSeconds", "unsentSeconds", "unreadSeconds", "writeDelayMs", "fetchDelays"}` | the chain cannot be read, search is rate limited, the next paid order is refused (`provider_unavailable`, `rate_limited` with a wait of `MOCK_RETRY_AFTER_SECONDS`, 30 s, `catalog_changed` with the name's price now, `internal`; `null` clears it), finding a code's orders is rate limited, no transaction goes out for that many seconds (each is tried again every `MOCK_RESEND_MS`, 5 s, until it goes out), the registration view's own chain reads fail for that many seconds (the view names them in `unread`), every write to a registration waits that long before its check (to race two requests), or each fetch of a link's data, in a search or a preview, takes the milliseconds given for that link (`{link: ms}`, `{}` clears them; a profile that was read is kept 10 minutes and answered at once, as the service caches it, while one not read is fetched again) |
| `/control/mismatch` `{"price", "policy", "termsHash", "method", "address", "amount"}` | answers that differ from the values the page holds, until the next call, which sets the mismatches it names and clears the others: each search answers `price` in cents, each sign answer and order view asks for the acceptance under another policy (`policy: true`) or of another terms hash (`termsHash: true`), and the next invoice, and its order's view, has another payment method than the order asked for (`method: true`), its order keeping the dispute days of the method asked for; the next invoice of the coin given in `address` (`btc` or `xmr`) has an address of another wallet, with that wallet's proof, which the page's keys do not prove, and the next invoice an amount a dollar over its name's price (`amount: true`) |
| `/control/general-terms` `{"text"}` or `{"link"}` | the owner sets the name policy's general terms to the link of this text, written to `dev/terms/`, to this link as it is, or back to the deployed link with a `null` text; an order or a selection of a name signing the old terms is refused with `terms_changed`, and the buyer of an order signed under them is asked to agree again before its reveal |
| `/control/community` `{"label", "for"}` | the name goes on the name policy's community list with what it is for, or comes off it with `null`; a registered name cannot be listed |
| `/control/community-terms` `{"text"}` or `{"link"}` | as `/control/general-terms`, for the community terms |
| `/control/edits` `{"limit"}` or `{"label", "count", "at"}` | the link edits a name gets in any 365 days, 1 to 100, as a restart with a new `[names] record_edits_per_year` would (3 at the start); or the name's counted edits, `count` of them made at `at` (unix seconds, now when left out), in place of those it has. As the service, a name with none left is refused with `409 {"type": "edit_limit", "nextAt"}` and its search answer's `found.records.edits` says when the next one returns; an edit counts once it goes out, however it ends on chain: mined, reverted or expired |
| `/control/code` `{"minLength", "years", "state"}` | issues a prepaid code |
| `/control/code/state` `{"code", "state"}` | sets a prepaid code's state, as an order elsewhere taking it or letting it go |
| `/control/mode` `{"mode"}` | `codes` refuses every name invoice with `403 {"error": "codes_only"}`, as the service with `[names] codes_only` on; `open`, the mock's mode at its start, takes them again. `GET /control/mode` answers it, and `GET /api/config` carries it, as the service's does; the page's own mode is its build's (Codes only) |
| `/control/downtime` `{"on"}` | the service's downtime, as a restart with `[names] downtime` on or off sets it: `GET /api/config` answers it in `names.downtime`, and a name invoice, a code order and a selection are refused with `503 {"type": "downtime"}` |
| `/control/clock` `{"now"}` | the mock's clock is set to `now` (unix seconds), from where it runs on, and the chain is moved forward to it; a chain already past it is refused with `409 {"error": "chain_ahead"}`. The mock's answers carry its clock in their `Date` header |
| `/control/seed` `{"seed"}` | the mock's ids, references, addresses and codes are drawn from this text from now on, the same each time, or at random again with `null` |

`GET /control/state` dumps the mock's registrations, invoices and balances, and counts the order requests it answered signed and those it refused; `GET /control/invoice/<id>` and `GET /control/registration/<id>` answer an order's views to the tests without a signature.

The page signs every request for an order with the order's name key, as the service asks: each read of an invoice or a registration, long polls included, a cancel, a retry and a reveal sign `simplex.domains order <id> <action> <timestamp>` (`read`, `cancel`, `retry` or `reveal`), in the query of a `GET`, in the body of a `POST`, and in a reveal's body as `request: {timestamp, signature}` beside its reveal fields; the reveal inside a new order's `POST /api/invoice` carries none. The mock answers an unsigned request, one of another signer and one for an unknown id alike, `404 not_found`, and a timestamp outside its window `400 bad_request` before it looks the id up; the page then signs once more at the clock that answer's `Date` gave. A selection and a reveal of another signer are answered as an unknown id too: a selection whose message the order's owner did not sign, and a reveal without its order request signed by the owner. A reveal whose `RegisterName` the order's owner did not sign over its term and dispute days is refused `400 bad_request`. The order's page counts either answer to a reveal as a refusal. A browser without the order's name code sends no request for the order, and the order's link says "The name code is not in this browser" and "Enter it in Check your code to see this order."

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

`ulimit -c 0`, in each shell, keeps a browser or chain that crashes from leaving a core file. Slot i has its chain on port 8545+i, its deployment in `dev/local-chain-i.json` and its mock on 8099+i; Playwright starts its page server on 5173+i, and a codes-only page server, with `VITE_CODES_ONLY=true`, on 5273+i, or uses ones already there. `SLOTS` sets the workers too (4 by default; WebKit's at most 2, as its frames are drawn on the CPU); against a single backend, such as Docker Compose's, run with `SLOTS=1`. A slot takes about 1 GB of memory with its browser. A long run grows each chain's memory, so restart `start.sh` between full runs.

`npx playwright test` runs the `chromium`, `firefox` and `webkit` projects in one pool; `--project=chromium` (or `firefox`, `webkit`) runs one browser. Where memory is short, run the three one after another.

The tests run with reduced motion, so screens swap at once, except one test in `e2e/track.spec.ts`, which checks that each purchase step rises in, `e2e/frames.spec.ts`, which samples each frame of the swaps and fails on a near-empty one, and the tests in `e2e/motion.spec.ts` that check the motion itself: that it runs only for a reader who has not asked for less, that a swap never shows two screens at once, that a redraw replays nothing already shown, and that controls follow a switch of theme. `e2e/frames.spec.ts` runs in Chromium and, with `FIREFOX_158`, in Firefox 158: the `firefox158` project runs only this spec and exists only when `FIREFOX_158` names a Firefox 158 or later executable, launched through Playwright's `moz-firefox` channel with its own libraries. While `FIREFOX_158` is set, a plain `npx playwright test` runs `firefox158` too. The `firefox` and `webkit` projects skip it.

`e2e/screens.spec.ts` compares the page in each of its states with committed screenshots; it runs only in the `screens` project, which exists with `SCREENS=1`, in Playwright's Docker image, as `e2e/README.md` says.

With `SHOTS=1` the tests write every screen they reach to `screenshots/` (or `SCREENSHOTS_DIR`), on a desktop and a phone, light and dark; Firefox's and WebKit's go to `screenshots/firefox/` and `screenshots/webkit/`, WebKit's in light only.

The service worker is in a built page only, so `e2e/offline.spec.ts` runs only against one and is skipped otherwise. A built page holds the policy given under Hosting, which `vite.config.ts` writes into its head, and a test fails on any violation a page reports. With slot 0 of the backend up, serve a build for the dev chain, which proxies `/api` to slot 0's mock, and point the tests at it from another shell; they then run in one worker:

```
npx vite build --mode devchain && npx vite preview --host 127.0.0.1
BASE_URL=http://127.0.0.1:4173 npx playwright test e2e/offline.spec.ts e2e/track.spec.ts e2e/mode-cache.spec.ts e2e/card.spec.ts e2e/pages.spec.ts
```

A build for an API on its own origin asks slot 0's mock directly, which answers it with CORS headers:

```
VITE_API_ORIGIN=http://127.0.0.1:8099 npx vite build --mode devchain --outDir dist-api && npx vite preview --host 127.0.0.1 --port 4174 --outDir dist-api
API_ORIGIN=http://127.0.0.1:8099 BASE_URL=http://127.0.0.1:4174 npx playwright test e2e/pages.spec.ts
```

`npm run build` builds the production page, which holds `MAINNET`, and `test/build.test.ts` checks that it holds no `LOCAL` value; `--mode devchain` builds with `LOCAL`, as Vite reserves the mode name `local`.

`e2e/mode-cache.spec.ts` serves `dist/` itself, with the caching headers of the host before GitHub Pages, and puts it in and out of its downtime between loads. Its tests follow a page left open across the downtime's end: back in view, restored by Back, holding a name typed and not searched, and against a service whose downtime flips with every answer. In Chromium the Back test launches the full Chromium build (Playwright's `chromium` channel) with its back/forward cache on; Playwright keeps that cache off in Firefox and WebKit, where the test fires the restore's `pageshow` itself. Headless browsers keep every tab in view, so the tests fire `visibilitychange` themselves.

### CI

`.github/workflows/webapp.yml` runs on pull requests and on pushes to master that change the webapp, its fonts or images:

- `unit`: `npm test` and `npm run build`.
- `pages`, on a push to master after `unit`: `npm run build`, and `webapp/dist` deployed to GitHub Pages (Hosting).
- `e2e`, one job per browser (Chromium, Firefox, WebKit): the dev image of `dev/Dockerfile` runs `dev/start.sh` with 3 slots, 2 for WebKit, and the browser tests run against it; then the built page's tests run against `vite preview` of a build for the dev chain, and, in the step "API on its own origin", `e2e/pages.spec.ts` against a build with `VITE_API_ORIGIN` at slot 0's mock; in the Chromium job, the step "Screens" compares the screenshots.

The image's layers are cached between runs, so the contracts compile only when the Dockerfile's commits change. A failed `e2e` job prints the backend's log and uploads `test-results/`.

## Codes only

Until the full launch, names are registered only with prepaid codes. The mode is the page's own, `SITE.codesOnly`, which a page release changes: `MAINNET` holds codes mode, `LOCAL` open mode, and a dev server or build with `VITE_CODES_ONLY=true` codes mode; the browser tests of codes mode run against such a server. The service's `[names] codes_only` refuses payments on its side, and its `GET /api/config` still says it, which the page does not read. In `codes` mode:

- The home's search field and its button are off, greyed with a not-allowed pointer, and take no focus or Enter, until the tab holds a prepaid code; one line says names can be registered with an investor code for now, and the screen's one action, Register with code, opens Check your code (`/#/code`).
- With a code, the search answers a name shorter than the code covers at once, without asking the service, and Check your order has no payment choices and no Pay with ETH: the tab's code pays, or, once it is taken off, a code entered in the field that takes the choices' place.
- Nothing offers a payment: a closed invoice offers no new one; refunds, Your names, restoring, link edits and order pages work as in `open` mode.
- The service answers `403 {"error": "codes_only"}` to `POST /api/invoice` for a name. A page of an open release meets it while the service is in codes mode: Check your order then says registration is by code only for now, and a closed invoice's page says so under its button, each with a way to enter a code. The screen after it is a fresh load of the page, which a newer release may have replaced.

## Downtime

A page that read the service in its downtime loads again once it reads that the downtime is over, so that a tab loaded before a page release signs with the released values (`src/views/served-mode.ts`). A load reads `GET /api/config` before it draws, and the page reads it again, past the HTTP cache, at each search, at each read of an order it follows, each time the tab comes back into view, and when Back or Forward restores it from the browser's cache. Once the downtime is over, the page loads again at once if that loses nothing: no order or change on its way, no card form, no field typed into and not kept, no terms ticked on an order's page, a tick only the page holds, and storage holding everything the tab keeps. Otherwise it loads again at its next screen. The checkout, the tab's code and the orders are in storage, so a reload keeps them. A service whose downtime flips with every answer reloads the page at most once per return to the tab. A tab that reads no answer in the whole downtime, as one hidden through it, keeps the values it loaded with: the service refuses what it signs with values the release changed, and its next load takes the released ones.

While a value the page holds changes, the service is in its downtime (`[names] downtime`): it refuses a name invoice, a code order and a selection with `503 {"type": "downtime"}`, and answers reveals, retries, reads and cancels. While the page last read the downtime:

- The home says "New orders open again soon." under the search, and an available name's row has no Register.
- A checkout opened, or its order sent, says that new orders open again soon; so does a closed invoice's page when it asks for a new invoice.
- An open invoice's page shows its status without its payment details: no address, amount or QR code, and no card form unless one is mounted already; it says "Payment opens again soon."
- A committed order's page signs no reveal, and says that the registration is not signed yet.
- The page of an order failed while it was not read has Continue off, and says "Signing opens again soon."
- Registered orders, Your names and Check your code are as outside the downtime.

## Hosting

`npm run build` writes a static site to `dist/`, which the workflow's `pages` job deploys to GitHub Pages at `simplex.domains` on each push to master, after `unit` passes. The page asks the service at `SITE.apiOrigin`, `https://api.simplex.domains`, which answers it with CORS headers; a build for the dev chain asks its own origin, through Vite's proxy, unless `VITE_API_ORIGIN` names another, as CI's step "API on its own origin" does with the mock. GitHub Pages sends a fixed set of headers, so the page's policy is a `<meta http-equiv="Content-Security-Policy">`, the first element of its head, that the build writes with the hashes of its inline scripts: `default-src 'self'; script-src 'self' <hashes>; frame-src <SITE.cardOrigin>; connect-src 'self' <SITE.apiOrigin>; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`, with `<meta name="referrer" content="strict-origin-when-cross-origin">`. A meta policy cannot forbid framing, so a page loaded in another page's frame draws only "This page opens only in its own tab." with a link that opens it. GitHub Pages sends none of `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` and `Cross-Origin-Opener-Policy`, which the Caddy block that served the page sent, and serves every file with `Cache-Control: max-age=600`: a release reaches a returning reader within 600 seconds, which step 6 of a held value's change waits for, and the page registers its worker past the HTTP cache. The page and its host rely on:

- The repository's settings: Pages built by GitHub Actions, with the custom domain `simplex.domains` and Enforce HTTPS; the environment `github-pages` deployable from master alone; a required review on master; branches up to date before merging, so a pull request's `e2e` ran on the tree the `pages` job deploys.
- The organization's settings: `simplex.domains` verified for GitHub Pages.
- The card page's repository with the same settings and the custom domain `pay.simplex.domains`.
- File names under `/assets/` carrying a content hash; `no-store` on the service's `/api/*`.
- `/sw.js` served from the site's root, as JavaScript. It is the service worker `sw/plugin.ts` writes into the build: it keeps this build's shell and files in one cache per build, so the page and Your names open offline. The shell is network first, with no deadline, as it decides the build: the cached shell is served only when the network fails or the server answers an error, and each fresh shell that names this build's entry module replaces it. `GET /api/config`, on the page's origin or at `SITE.apiOrigin`, is network first too, each answer kept, so the page opens offline with the downtime the service last gave; the build's files are cache first; the rest of `/api/*`, a request for `/` that is not a page load, the rest of other origins and anything else go to the network untouched. The page registers it in the production build only, past the HTTP cache. To take it out, serve a `sw.js` whose install deletes every cache and calls `self.registration.unregister()`.
- Brotli or gzip for HTML, JS, CSS and `favicon.ico`.
- A 404 for unknown paths: the app's routes live in the hash and the query, never in the path.
- The page's own policy. `e2e/offline.spec.ts`, `e2e/track.spec.ts`, `e2e/mode-cache.spec.ts`, `e2e/card.spec.ts` and `e2e/pages.spec.ts` run with `BASE_URL` at `vite preview` of a build for the dev chain, and report no violation of its meta policy in Chromium, Firefox and WebKit, with the card page framed; a live Stripe key and 3-D Secure in the card page are still to be checked.
- Stripe.js runs only in the card page, on its own origin, away from the owner codes and prepaid codes this origin keeps in `localStorage`; the names page's CSP admits no Stripe host and frames the card page's origin alone.
- The Stripe publishable key in `SITE.stripeKey`, which the card page holds. The service must create each PaymentIntent with `payment_method_types: ["card"]`: the card page mounts the Payment Element with Apple Pay, Google Pay and Link off and keeps room for the card form alone, and a form that Stripe cannot load, or that has not loaded after 20 s, leads to the card-not-confirmed page.
- `/manifest.webmanifest` as `application/manifest+json`. With the service worker it makes the site installable as an app; its icons in `img/` are rendered from the SimpleX symbol by `node dev/app-icons.mjs ../img/simplex-symbol-light.svg ../img`.

### Changing a value the page holds

A value of `MAINNET` other than a payee key changes in the service's downtime, in this order:

1. The operator restarts the service with `[names] downtime = on`.
2. The operator drains the queue: the worker registers the orders queued with their reveals, and the providers settle the payments in progress, until no order the service moves on is left, or for 15 minutes at most.
3. The owner and the Safe's signers change the chain: the terms by `setGeneralTerms` or `setCommunityTerms`, the prices by the price oracle.
4. The operator releases the service with the new values, still in its downtime, with the payee keys in BTCPay and the ini.
5. The owner merges the pull request of this repository with the new `MAINNET`, which the `pages` job deploys; with a new Stripe key, the card page's repository moves to that merge. Before the merge, `RPC_URL=<a mainnet RPC> npm run check:mainnet` reads the controller's sponsor, resolver, name policy and TLD, the price oracle's base and exceptions, and the policy's terms links and hashes, and compares them with `MAINNET`.
6. The operator restarts the service with `downtime = off`, once the `pages` jobs of step 5 have completed and 600 seconds, the `max-age` GitHub Pages serves with, have passed.
7. The page of each open order signs it again with the new values, its buyer accepting changed terms first; an order failed while its page was not read is signed again by Continue.
8. The owner moves `apps/simplex-domains` in simplex-chat to the merge of step 5.

The service's ini holds these values too: `[names]` `term_start`, `years`, `codes_only` and `tld`; `[chain]` `chain_id` and the contract addresses; the payee keys; `[stripe] publishable_key`. A change of the resolver or the TLD changes the commitment of every open order, so the drain of step 2 runs without its cap, and support closes an order still open after it.

A payee key changes in three steps: a page release adds the new Bitcoin key or Monero primary address to `MAINNET`; BTCPay and the service's ini switch to the new wallet; a page release removes the old key once its last invoice has expired.

## Not decided or not built

- The mock is a development fixture, not the service: it keeps everything in memory and moves no money.
