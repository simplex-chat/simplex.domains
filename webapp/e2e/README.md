# Browser tests

The specs run against the dev backend, as ../README.md says under Test.

## Screens

`screens.spec.ts` puts the page into each of its states and compares each with a PNG file in `screens/`, at 1280×800 (`<state>-desktop.png`) and 390×844 (`<state>-phone.png`). A difference fails the test.

States that are rows of one screen share one image: each `names-rows-*` screen draws Your names with one row in each of the states its `covers` lists. A state drawn only on a phone with a camera, or only at a phone's width, has its phone image alone; the camera's picture is masked.

Every run draws the same pixels:

- each state runs at its own fixed time: `/control/clock` sets the mock's clock and moves the chain to it, and the page's clock is set to the same moment;
- `/control/seed` makes the mock's ids, references, addresses and codes depend only on the state;
- an init script makes the page's own random bytes, as its name codes, depend only on the state, and so do the name codes the spec itself makes;
- a time shown to the minute comes from a step made at a set time: a state whose steps take longer than a minute sets the mock's clock before it;
- countdowns are masked, and each waits 20 seconds or more, so its words keep their number;
- each screenshot waits for the page's fonts;
- `screens.css`, applied only while a screenshot is taken, draws the page's background flat, which makes each file about a quarter of the size, draws a wait's bar half full, as its fill grows from the moment the page first saw the wait, and draws a countdown's digits at one width, so its mask keeps its size.

A state that waits while the chain sends nothing (`unsentSeconds`) needs the mock to try its transactions for long enough: `MOCK_RESENDS=600`.

A chain's time only moves forward, and the mock keeps the orders that the seeded ids name, so every run starts a fresh backend whose chain starts before the first state's time: `CHAIN_START=1793602800` (2 November 2026, 07:00 UTC).

Fonts differ between machines, so the baselines are recorded and compared in Playwright's Docker image of the version in package.json. CI runs them in the chromium job of `.github/workflows/webapp.yml`, step Screens.

### Updating the baselines

After a change of the page, record the baselines again and commit the changed files in `screens/`:

- from CI: a run that meets a changed or missing screenshot fails and uploads the artifact `screens`, which holds `e2e/screens/` with each missing baseline recorded, and the artifact `e2e-chromium`, which holds each changed state's `<state>-<size>-actual.png` under `screens/`; copy them into `e2e/screens/` as `<state>-<size>.png`;
- locally, with Docker: start a fresh backend, then run the spec in the image.

```
CHAIN_START=1793602800 MIN_COMMITMENT_AGE=5 MOCK_RESEND_MS=1000 MOCK_RESENDS=600 ENS_CONTRACTS_DIR=<ens-contracts> dev/start.sh
docker run --rm --network host --ipc host -v "$PWD/..:/work" -w /work/webapp -e SCREENS=1 -e SLOTS=1 \
  mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test --project=screens --update-snapshots
```

A new state takes the next free time slot in `screens.spec.ts`; states run in the order of their slots.
