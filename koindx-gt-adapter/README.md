# koindx-gt-adapter

An HTTP adapter that lets GeckoTerminal index the KoinDX exchange on the Koinos blockchain. It implements the
**GeckoTerminal Integration API Standards v0.1** (Nov 2024), the adapter GeckoTerminal asks chain teams to host for
non-EVM chains ("How to integrate Non-EVM Chain/DEX on GeckoTerminal").

It has no dependencies: Node.js 20+ and its built-in `http` and `fetch`. Nothing is installed from npm.

```
npm test                                   # unit and HTTP tests, offline
KOINOS_RPC=http://127.0.0.1:8080 npm start # adapter on 127.0.0.1:3900
npm run conformance                        # live check against a running adapter (see below)
```

## Endpoints

| Spec endpoint | Source |
|---|---|
| `GET /latest-block` | `chain.get_head_info`. Returns the **last irreversible block**, never the head. GeckoTerminal reads every block once, so it only sees blocks that can no longer change. |
| `GET /asset?id=` | KCS-4 read methods `name`, `symbol`, `decimals`, `total_supply` of the token contract. `totalSupply` is decimalized. |
| `GET /pair?id=` | `get_tokens` of the pair, which gives `asset0`/`asset1` in on-chain `token_a`/`token_b` order, so it never changes. `feeBps` 25. The creation block and transaction come from the pair's first account-history record. |
| `GET /events?fromBlock=&toBlock=` | `block_store.get_blocks_by_height` with receipts, fetched in chunks of 1000 blocks. KoinDX `swap_event` → `swap`, `mint_event` → `join`, `burn_event` → `exit`. |
| `GET /` | Not part of the spec: describes the adapter (endpoints, limits, network and DEX facts). This is the documentation URL for GeckoTerminal's form. |
| `GET /health` | Not part of the spec: head, last irreversible block and known pairs; the last event that could not be represented; swaps of pools that run KoinDX code under another router; and contracts that emit KoinDX event names but run unknown code. |

Errors are JSON `{ "error": ... }`: `400` bad input, `404` unknown id, `503` node unavailable or block not yet irreversible.

## How the data is built

- **Which contracts count as KoinDX pairs.** A contract counts only if the bytecode it runs *now* has the KoinDX
  pair code hash (`get_contract_metadata` system call, read-only), and swaps and burns must name the KoinDX periphery
  `17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s` as caller. The pair code only accepts swap/mint/burn from its periphery, so a
  look-alike contract that emits events with the same names is ignored and listed under `unknownCode` on `/health`.
  The periphery's own `get_pair` registry cannot be used: on chain it answers empty for every live pair.
  If a contract with an unknown code hash names the KoinDX periphery as its caller (possibly new KoinDX pair
  code), it is reported on `/health` (`suspectedKoindxPools`) and in the log. It cannot fail the answer,
  because the caller field is written by the contract itself and could be forged.
- **Deliberately not listed.** A second, older KoinDX router, `14WeQjBk7F4C58xUquRGLK1KiqRjwj5Y4J` (same fee
  recipient), ran 11 pools on the older pair code `122009c6…`. Almost all of them quote the deprecated KOIN
  contract `15DJN4a8…`, and the router has not been used since 2023-11-24: 1,064 swaps in total. Those pools
  are excluded on purpose (`KOINDX_EXCLUDED_CODE_HASHES`) rather than silently.
- **Reserves.** The pair emits `sync_event` (reserves after the change) right before each swap, mint and burn in the
  same call, so every event carries the reserves of the last `sync_event` of the same pair in the same transaction.
- **Swap amounts.** The direction comes from what the pool paid out; the periphery always asks for exactly one
  side. `assetOut` is that amount, which the spec defines as "the amount that goes out of the liquidity pool as a
  product of the math curve". `assetIn` is what the pool received of the other token.
  Some tokens charge a tax on every transfer, and part of that tax can flow back into the pool on the paid-out side
  during the swap. That inflow is not part of the trade, and it is already in the reserves. This occurs live, for
  example at block 39,585,230 with a 5 % tax token. `priceNative` is the execution price of asset0 in asset1,
  computed exactly with integers to 50 decimals. `metadata.fees0In`/`fees1In` is the 0.25 % KoinDX fee on the
  input (`amountIn * 9975 / 10000` in the periphery).
- **Nothing is dropped quietly.** GeckoTerminal reads every block once. A KoinDX event that cannot be represented
  exactly therefore fails the whole `/events` answer with `503` instead of being skipped. That covers an event
  that cannot be decoded, a swap, join or exit without the pool's `sync_event` before it, and a swap without a
  single direction. The failure is logged and shown as `lastError` on `/health` until the code handles the case;
  GeckoTerminal retries. Each `sync_event` is consumed by one action.
- **Numbers.** All amounts are decimalized exact strings (no floating point anywhere). Timestamps are UNIX seconds.
- **Order and identity.** `txnIndex` is the transaction's position in the block, `eventIndex` the event's position in
  the transaction receipt, `txnId` the Koinos transaction id (`0x1220…`, the explorer format). `maker` is the
  transaction's `payee` (the signer when someone else pays the mana), otherwise its `payer`. Reverted transactions
  are ignored.
- **Completeness.** An `/events` answer never misses a block or a transaction. Every node answer is checked for
  block count, contiguous heights, header, timestamp, and transactions matching receipts. The transaction list is
  also checked against the **transaction Merkle root in the block header**, recomputed the way `koinos-chain` does
  it. Failed checks are retried, and a `503` is returned if the answer stays incomplete. A range that reaches past
  the last irreversible block is refused with `503`. Blocks are processed 1000 at a time, so only the events stay
  in memory.

## Verified

- **Unit tests** (`npm test`, 16 tests).
  - A real block with a 7-hop KoinDX swap is decoded and compared field by field with the same transaction as
    decoded by the public Koinos REST API, an independent decoder that uses the on-chain ABI. Amounts, reserves,
    prices, maker, block and indexes are identical.
  - A real transfer-tax swap is tested as a regression case.
  - Synthetic receipts cover joins and exits, reverted transactions, look-alike contracts, foreign callers,
    swaps without a direction, reuse of a `sync_event`, and undecodable data.
  - The Merkle root is checked against a real block. The RPC layer is tested so that it never passes on an
    incomplete block answer, including a block whose transactions were removed.
  - The worker pool, the admission queue (including a client that gives up while queued), and pair lookups shared
    by `/pair` and `/events` are tested.
- **HTTP tests.** Every endpoint is checked against the spec schema (`test/spec-check.js`), together with bad
  input, 404s, the irreversibility guard, chunking, a failing node, an unrepresentable event, and overload.
- **Merkle algorithm.** The recomputed Merkle root matched the block header on 4,000 sampled blocks from 2022 to
  2026, including blocks with 2, 3 and 4 transactions, and on every block of the live runs.
- **Live conformance** (`scripts/conformance.mjs`), run on 2026-09-23 against the public API:

  | | Blocks | Time | Events | Pairs | KOIN/vUSDT vs REST history |
  |---|---|---|---|---|---|
  | 14-day window | 403,201 | 136 s | 5,147 (5,098 swaps, 11 joins, 38 exits) | 355 | 96 of 96 identical |
  | 3-day run after the last change | | | | | 33 of 33 identical |

  The KOIN/vUSDT comparison is transaction by transaction against the pool's account history as decoded by the
  REST API: amounts, reserves, block and txnIndex.
- **Review.** Three review rounds with a second model: a full review with 11 findings fixed, a verification round
  with 3 more fixed, and a final check that passed with no remaining defects.

## Configuration

| Variable | Default | |
|---|---|---|
| `KOINOS_RPC` | `https://api.koinos.io` | **Use your own node in production.** The public endpoint is load balanced over nodes that sometimes lack blocks. The adapter retries and never serves partial data, but it gets slower. |
| `HOST` / `PORT` | `127.0.0.1` / `3900` | Put nginx with TLS and a rate limit in front of it. |
| `MAX_BLOCK_RANGE` | `10000` | Largest `/events` range. Ask GeckoTerminal to use a chunk size of this value or less. Deployed value since 2026-10-07: `100000` (GeckoTerminal's indexer asks for ~38k-block ranges; measured 16–36 s per 100k against the 95 s nginx read timeout). |
| `CHUNK_SIZE`, `RPC_CONCURRENCY` | `1000`, `3` | The node answers at most 1000 blocks per call. |
| `MAX_CONCURRENT_EVENTS`, `MAX_QUEUED_EVENTS` | `2`, `8` | `/events` requests served at once and waiting; beyond that `503` busy. |
| `MAX_CONCURRENT_LIGHT`, `MAX_QUEUED_LIGHT` | `8`, `32` | The same for `/latest-block`, `/asset` and `/pair`. |
| `ACCOUNT_HISTORY` | `on` | Pairs get their creation block from the node's account history; node errors then give `503`. `off` leaves the optional `createdAt*` fields out. |
| `RPC_TIMEOUT_MS`, `RPC_RETRIES` | `30000`, `5` | |
| `DATA_DIR` | `./data` | `koindx-cache.json` holds verified pairs and creation blocks, which never change. |
| `KOINDX_PERIPHERIES` | `17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s` | Comma separated. |
| `KOINDX_PAIR_CODE_HASHES` | `1220a3ca71ad…a532` | Comma separated. If `/health` shows a genuine pair under `unknownCode`, add its hash here. |
| `KOINDX_EXCLUDED_CODE_HASHES` | `122009c684b1…54e8` | Pair code that is known and deliberately not listed (see above). |
| `COINGECKO_IDS` | `{}` | JSON `{ "<asset id>": "<coingecko id>" }`. See the open questions before setting it. |

The node needs `chain`, `block_store` (with receipts), `transaction_store` and the `get_contract_metadata` system call
through `chain.invoke_system_call`. `account_history` is optional (`ACCOUNT_HISTORY=off`).

## Deployment

A public instance runs at `https://api.koinosscan.com/geckoterminal/` (`/health` shows its state). To run your own,
point `KOINOS_RPC` at a node of your own, keep the adapter on loopback and put nginx with TLS and a rate limit in front
of it. `scripts/backfill-check.mjs` walks the full KoinDX history (from block 8,613,000) against a node and checks
that every block decodes.

Open questions for CoinGecko/GeckoTerminal:

- **USD anchor.** KoinDX's dollar pairs quote in vUSDT and vUSDC, which are USDT and USDC bridged by Vortex.
  `coinGeckoId` is unset on purpose. Mapping them to `tether` / `usd-coin` would claim they are the native coins, so
  that should only be set if CoinGecko says so.
- **KOIN.** KOIN's own `coinGeckoId` would be `koinos`, but that page is inactive with a price frozen since March.
  Ask whether to set it before doing so.

## Known limits

- **Governance transactions.** A governance proposal that takes effect in a block runs as a transaction that is not
  part of the block, so the block's receipt has one transaction receipt more than the block has transactions
  (first seen at block 11,862,812, identical on every node). Receipts are matched to the block's transactions by id;
  such an extra receipt has no `txnIndex`, so a KoinDX event inside one would fail `/events` loudly instead of being
  given a made-up index. None has been seen.

- A pair that references a token by name service (KOIN, VHP) reports the token's current address. Events from
  before the 2024 KOIN contract migration carry the same 8-decimal KOIN amounts under the current address.
- Multi-asset pools do not exist on KoinDX, so the `pool` field is not used.
