# Lifecount

[![test](https://github.com/tommaso-sacchetti/lifecount/actions/workflows/test.yml/badge.svg)](https://github.com/tommaso-sacchetti/lifecount/actions/workflows/test.yml)

A synced life counter for Commander, the multiplayer Magic: The Gathering format. Each player uses their own phone. Every change to life, poison or commander damage shows up on all phones at the table within a second. It runs in the browser: one person creates a table, the others scan a QR code. No install, no account.

The server is a single Node file with no dependencies; the client is plain JavaScript with no build step.

**Live:** [lifecount.onrender.com](https://lifecount.onrender.com) (free hosting: the first visit after a quiet period takes about a minute to wake the server).

## Features

- **Your life big, everyone else readable.** Your total fills the bottom of the screen. Opponents are placed at the top as you see them from your seat.
- **Anyone can change anything.** Tap an opponent's − or +, or open a player for poison, commander damage (which also removes life), monarch and elimination.
- **Table actions.** Everyone loses N, drain, proliferate and similar effects in one tap, undone in one tap.
- **Undo and log.** Rapid taps merge into one entry (`Luca −7`). A badge shows who just changed a total.
- **Turns, optional.** Whose turn it is, a Pass button and a turn timer. Can be switched off in the lobby or mid-game.
- **Players without a phone.** Added in the lobby and updated from anyone's phone. They can take over their seat with a phone later.
- **Commander search.** Type a few letters and pick from legal commanders (Scryfall). The card art appears on the player's tile.
- **Stats.** Wins, damage dealt, KOs, turn times and commanders per player, plus a life chart for each game.
- **In-app guide** at `#/help`, linked from the screen people land on after scanning the QR code.

## How it works

```
 phone ──POST action──▶ server ──SSE full state──▶ every phone at the table
   ▲                     │
   └─ shows the tap      └─ validates, applies, logs, saves to disk
      immediately
```

The server owns the game state. A phone sends an action (`adjust`, `passTurn`, `eliminate`, ...), the server applies it and pushes the complete table state to every phone over Server-Sent Events. The phone that tapped shows the change immediately and reconciles when the server's state arrives.

Details on state shape, actions, API, persistence and stats: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Design decisions

- **Server-authoritative, full-state broadcast.** One place decides what happened, so phones can't disagree. A table's state is a few kilobytes, so sending all of it is simpler than diffs and lets a phone that reconnects catch up with no extra logic.
- **Server-Sent Events, not WebSockets.** Phones only need to receive pushes; actions go over normal `POST`. SSE is plain HTTP, reconnects on its own in every browser, and needs no library.
- **Optimistic taps.** A tap updates the screen before the server answers. Server states that arrive while taps are still in flight are held back, so a slow reply can't undo a newer tap.
- **No dependencies, no build.** It runs anywhere Node 18 runs, including a laptop on a Wi-Fi network with no internet (fonts and the QR library are bundled). There is nothing to update or audit.
- **No accounts.** Joining takes a code and a name. Anyone at the table can change anything, as they would with dice and paper. The host only has power to close the table or remove a connected player.
- **Lethal is suggested, not enforced.** At 0 life, 10 poison or 21 commander damage a player is marked *Lethal*, but elimination is manual, because life gain in response is part of the game.
- **Stats without extra input.** Lowering another player's life from your phone counts as your damage; commander damage has an explicit source. KOs go to the last player who dealt damage. Nobody has to record anything after the game.

## Run locally

```bash
npm start      # node server.js
npm run dev    # restart on file changes
npm test       # unit tests, then the end-to-end test
```

Requires Node 18 or newer, nothing to install. The server prints a `localhost` URL and a LAN URL; phones on the same Wi-Fi open the LAN URL, and the lobby QR code points to it.

| env var        | default  | meaning                                       |
| -------------- | -------- | --------------------------------------------- |
| `PORT`         | 3000     | HTTP port                                     |
| `IDLE_MINUTES` | 180      | a table with no actions for this long closes  |
| `DATA_DIR`     | `./data` | where open tables and game history are stored |

## Deploy

`render.yaml` deploys it as one web service on [Render](https://render.com); pushing to `main` redeploys. On the free plan the service sleeps after 15 minutes without requests (the first request then takes about a minute) and the disk is wiped on restart, which clears open tables and stats. While a table is open, phones poll every 5 minutes so the service stays awake during a game. Any host with a persistent disk keeps the history.

HTTPS is needed for the screen Wake Lock and for adding the app to the home screen.

## Project layout

```
server.js            HTTP server, action reducer, SSE, persistence, idle sweep, stats
public/app.js        client: routing, rendering, optimistic updates, commander search
public/styles.css    design tokens and components
public/vendor/       QR generator, Barlow fonts
test/smoke.mjs       starts the server and plays games over HTTP
docs/ARCHITECTURE.md technical reference
render.yaml          Render blueprint
```

## Testing

`npm test` runs two layers, both on Node's built-in tools (no test framework). GitHub Actions runs them on Node 22 and 24 on every push.

- **Unit tests** (`test/game.test.mjs`) call the action reducer directly on a session object: damage attribution, merging rapid taps, commander damage rules, undo of grouped actions, turn order with eliminated players and duplicate passes, places and winner, monarch, turn tracking, unique names, and the Scryfall URL filter.
- **End-to-end test** (`test/smoke.mjs`) starts the real server with a temporary data directory and plays through the HTTP API: a 4-player game, a second client that must receive the same states over SSE, stats, closing a table mid-game, players without a phone, and turn tracking switched during a game.

## Limits

- **One process, state in memory.** Enough for groups of friends. To run several instances, table state would move to a shared store (Redis or Postgres) with pub/sub to fan out updates, and the history file to a database.
- **Names are identities.** Stats group players by name, case-insensitive. Two people with the same name in different games are merged; within one table names must be unique.
- **Trust.** Anyone with the code can change the game. Per-seat tokens would be the next step if that mattered.
- **Players without a phone** can only be added in the lobby, not mid-game.

Card names and images come from [Scryfall](https://scryfall.com). Lifecount is not affiliated with Wizards of the Coast.
