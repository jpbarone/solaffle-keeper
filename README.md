# Solaffle keeper (Node)

Automated Switchboard **VRF** draws + prize delivery for the Solaffle raffle
program. This is the Node version of the keeper — the Supabase **Deno** edge
runtime can't bundle the Switchboard + anchor dependencies (bundle timeout), so
the keeper runs here instead, in the same environment the standalone draw script
is proven in.

Each pass it: (1) recovers any raffle stuck mid-draw, (2) draws newly-endable
raffles with VRF (commit → oracle reveal → settle), (3) delivers SOL/token
prizes, (4) reclaims SOL from failed raffles. All actions are permissionless
on-chain — the keeper only pays gas + tiny randomness-account rent and can never
redirect prize funds.

## Files to add before deploying

- `solotto_raffle.json` — the deployed program IDL (0.31 format, program
  `8myz5A4jzJ5LqZbCju9aS9tUnFxqMLih5RPeVjttWCYN`). The IDL is public — safe to
  commit. Copy it in next to `index.ts`.

## The keeper wallet

Generate a fresh, low-value wallet. It only pays fees, so keep almost nothing on
it and top it up as needed:

```bash
solana-keygen new -o keeper.json
solana address -k keeper.json
solana airdrop 2 $(solana address -k keeper.json) --url devnet
cat keeper.json     # the [12,34,...] array -> KEEPER_SECRET
```

Each VRF draw creates a Switchboard randomness account (~0.002 SOL rent, not
auto-reclaimed) on top of gas, so fund a bit generously.

## Run locally

```bash
npm install
cp .env.example .env    # fill in RPC_URL + KEEPER_SECRET
npm run once            # a single pass, prints a JSON summary
npm start               # long-running loop (default every 60s)
```

A pass prints e.g.:

```json
{"ts":"...","scanned":3,"drew":1,"settledStuck":0,"refunded":0,"delivered":1,"reclaimed":0,"errors":[]}
```

## Deploy — pick one host

### Railway / Render / Fly (recommended — always-on, 60s cadence)

Point the host at this folder and use `npm start`. Set env vars `RPC_URL` and
`KEEPER_SECRET` (and optionally `KEEPER_INTERVAL_MS`) as service secrets. The
process loops on its own; no external scheduler needed.

- Render: "Background Worker", build `npm install`, start `npm start`.
- Railway: new service from repo, start command `npm start`.
- Fly: `fly launch` (no ports), `fly secrets set RPC_URL=... KEEPER_SECRET=...`.

### GitHub Actions (free, zero-infra — 5-min cadence)

Move `github-actions-keeper.yml` to `.github/workflows/keeper.yml`, commit the
folder (including `solotto_raffle.json`), and set repo **secrets** `RPC_URL` and
`KEEPER_SECRET`. It runs `npm run once` every 5 minutes. Good enough for devnet;
for production use an always-on host for tighter draw timing.

## Env vars

| var | required | notes |
|-----|----------|-------|
| `RPC_URL` | yes | devnet/mainnet RPC (Helius etc.) |
| `KEEPER_SECRET` | yes | JSON secret-key array of the keeper wallet |
| `IDL_PATH` | no | defaults to `./solotto_raffle.json` |
| `KEEPER_INTERVAL_MS` | no | loop interval, default `60000` (loop mode only) |

**Never** expose `KEEPER_SECRET` in a frontend / `VITE_` var — it's a host secret
only.

## Notes

- Draws at most 2 raffles per pass (`MAX_DRAWS_PER_RUN` in `index.ts`); backlog
  clears on later passes.
- A raffle briefly sits in `Drawing` between commit and settle; if a pass dies
  mid-draw, the next pass's recovery step finishes it from the randomness account
  recorded on-chain. If the committed slothash has expired (keeper down for
  minutes), that raffle shows up in `errors` as `stuck-draw` and needs manual
  admin recovery.
- Disable the old Deno/SlotHashes keeper cron before running this, so raffles
  aren't drawn twice / non-VRF: `select cron.unschedule('soldraw-keeper');`
