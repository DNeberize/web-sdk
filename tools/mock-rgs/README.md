# Mock RGS

A local stand-in for the Stake Engine RGS, so you can run the real game (not Storybook) without a Stake Engine account or session. No dependencies. Node >= 22.18 is needed to load the `.ts` sample books.

## Run

From the repo root, run one command:

```bash
pnpm dev
```

```bash
pnpm dev:price
```

[`tools/dev.mjs`](../dev.mjs) starts the mock and the app's dev server together. Once the app is ready, it opens `http://localhost:3001/?sessionID=local&rgs_url=http://localhost:4000&lang=en&currency=USD&device=desktop` in your browser, the same launch URL format Stake uses. Ctrl+C stops both, and `--no-open` skips opening the browser.

| Game | Game URL | Mock RGS |
|---|---|---|
| cluster | http://localhost:3001 | http://localhost:4000 |
| price | http://localhost:3002 | http://localhost:4001 |

To run the mock on its own, use `pnpm mock-rgs --game cluster`.

## Where books come from

| Flag | Source |
|---|---|
| `--game <app>` (default `cluster`) | `apps/<app>/src/stories/data/<mode>_books.ts`, the same books Storybook uses. Each book is picked with equal chance. Mode costs come from `apps/<app>/src/game/config.ts`. |
| `--math <dir>` | Math SDK output (`library/publish_files`): `index.json`, `books_<mode>.jsonl` or `.jsonl.zst`, and `lookUpTable_<mode>_0.csv`. Books are picked by lookup-table weight, and `payoutMultiplier` is divided by 100. |

Other flags: `--port 4000`, `--balance 1000`, `--currency USD`, and `--dev-port 3001` (only used in the printed URL).

## What it mocks

- `POST /wallet/authenticate`
- `POST /wallet/balance`
- `POST /wallet/play`
- `POST /wallet/end-round`
- `POST /bet/event`
- `GET /bet/replay/:game/:version/:mode/:bookID`

How it behaves:
- Sessions are kept in memory, and any `sessionID` is accepted.
- A play debits `amount × mode cost`. End-round credits `amount × payoutMultiplier`.
- A round with a win stays `active` until end-round is called.
- Authenticate returns the last round. If you reload in the middle of a bonus, you can test resume.

Dev helpers (use port 4001 for price):
- `GET /mock/status` shows the loaded modes, book counts and session balances.
- `GET /mock/force?mode=bonus&id=12` makes the next spin in that mode use book 12. Repeat `&id=` to queue several.
- `GET /mock/reset?sessionID=local` resets the balance and the active round.

Only the modes that have books are accepted: cluster has `base` and `bonus`, and price has `base`, `bonus` and `superspin`. The other buy buttons in the UI return "Unknown mode".

## Note

`rgs_url` normally has no protocol, and the game adds `https://`. To make plain `http://localhost` work, `packages/rgs-fetcher` now keeps an explicit `http://` or `https://` prefix as it is.
