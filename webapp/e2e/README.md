# Browser tests

The specs run against the dev backend, as ../README.md says under Test.

## Screens

`screens.spec.ts` puts the page into each of its states and compares each with a PNG file in `screens/`, at 1280×800 (`<state>-desktop.png`) and 390×844 (`<state>-phone.png`). A difference fails the test.

Every run draws the same pixels:

- each state runs at its own fixed time: `/control/clock` sets the mock's clock and moves the chain to it, and the page's clock is set to the same moment;
- `/control/seed` makes the mock's ids, references, addresses and codes depend only on the state;
- an init script makes the page's own random bytes, as its name codes, depend only on the state;
- countdowns are masked.

A chain's time only moves forward, so the states run on a fresh backend whose chain starts before the first state's time: `CHAIN_START=1793602800` (2 November 2026, 07:00 UTC).

Fonts differ between machines, so the baselines are recorded and compared in Playwright's Docker image of the version in package.json. CI runs them in the chromium job of `.github/workflows/webapp.yml`, step Screens.

### Updating the baselines

After a change of the page, record the baselines again and commit the changed files in `screens/`:

- from CI: a run that meets a changed or missing screenshot fails and uploads the artifact `screens`, which holds `e2e/screens/` with each missing baseline recorded, and the artifact `e2e-chromium`, which holds each changed state's `<state>-<size>-actual.png`; copy them into `e2e/screens/` as `<state>-<size>.png`;
- locally, with Docker: start a fresh backend, then run the spec in the image.

```
CHAIN_START=1793602800 MIN_COMMITMENT_AGE=5 MOCK_RESEND_MS=1000 MOCK_RETRY_AFTER_SECONDS=2 ENS_CONTRACTS_DIR=<ens-contracts> dev/start.sh
docker run --rm --network host --ipc host -v "$PWD/..:/work" -w /work/webapp -e SCREENS=1 -e SLOTS=1 \
  mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test --project=screens --update-snapshots
```

A new state takes the next free time slot in `screens.spec.ts`; states run in the order of their slots.
