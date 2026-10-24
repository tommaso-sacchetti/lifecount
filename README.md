# Lifecount

A synced Commander (EDH) life counter. Everyone at the table keeps their own phone with **their life big in the foreground** and **everyone else's life smaller but always readable** above it, laid out in table order. Any phone can change anyone's life, and every change shows up on every phone right away.

## Run it

```bash
npm start            # node server.js, no dependencies to install
```

It prints two URLs: `localhost` for the computer, and a `192.168.x.x` LAN address for phones. Everyone must be on the same Wi-Fi. Open the app on any device, create a table, and the QR code it shows already points at the LAN address.

| env var        | default | meaning                                   |
| -------------- | ------- | ----------------------------------------- |
| `PORT`         | 3000    | HTTP port                                 |
| `IDLE_MINUTES` | 180     | sessions with no actions close after this |
| `DATA_DIR`     | `./data`| where sessions and game history are saved |

`npm test` runs an end-to-end smoke test (it plays a 4-player game through the API and checks sync, stats and archiving).

## Product design

### Flow

1. **Create.** The host enters a name, optionally a commander, and picks a color. The app makes a session with a 4-letter code (no I or O) and a QR code.
2. **Join.** Friends scan the QR, or type the code, and take a seat. Name, commander and color are remembered on each phone for next time.
3. **Lobby.** The seat list is the table order: reorder it with ↑/↓ or shuffle it, then sit clockwise in that order. Choose starting life (20–60, default 40). Green dots show who is connected.
4. **Play.** Pick who goes first, or roll for it. Phones stay in sync through the whole game.
5. **End.** The game ends on its own when one player is left, or anyone can call it from the menu (with a winner or as a draw). A summary screen follows, then **Rematch** (same seats) or **Back to lobby**.
6. **Close.** The host can close the session for everyone. Otherwise it closes by itself after `IDLE_MINUTES` with no actions. A game still in progress at that point is saved as *abandoned*.

### The game screen

- **Your panel** (bottom, about 55%): a huge life total. Tap the left half for −1 and the right half for +1. Hold to repeat, with acceleration. Your poison and highest commander damage sit underneath, plus **Pass turn →** when it's your turn.
- **Opponents** (top) appear **in the shape of the table as you see it from your seat**: your left neighbour at bottom-left, your right neighbour at bottom-right, and the players across the table along the top row. With 3 opponents they form one row (left → across → right).
- Each opponent tile has −/+ buttons, badges (☣ poison, ⚔ commander damage, ♛ monarch, `KO?` when lethal), and a glowing border on whoever's turn it is.
- **Delta badges** like `−5 Marco` show who just changed a life total, so nobody is left wondering why their life dropped.
- **Tap any player** to open their sheet: ±1/5/10 life, poison, commander damage taken from each opponent (it subtracts life automatically), monarch, set as active player, eliminate / undo elimination.
- **Lethal is suggested, not enforced.** At 0 life, 10 poison or 21 commander damage the tile shows `KO?` and the Eliminate button lights up, because life-gain responses exist.
- **Menu:** invite QR (to rejoin mid-game), undo your last change, game log, end game, stats, leave, close session.
- The screen stays awake (Wake Lock) where the browser allows it, and taps buzz on Android.

### Sync & resilience

- The server holds the authoritative game state. Phones send *actions* (`adjust`, `passTurn`, `eliminate`, …), and the server applies them and pushes the full state to every phone over **Server-Sent Events**.
- Taps show up instantly on the phone that made them, and the server's version replaces the local one as soon as it arrives.
- Rapid taps on the same counter **merge into one log entry** (a 4-second window), so the log reads `Luca −7` instead of seven `−1`s.
- **Reconnect:** each phone remembers its seat per session. If a phone dies, open the link on another device and *claim* the seat.
- Sessions are saved to disk, so restarting the server doesn't lose a game.

### Data collected

Every finished or abandoned game is appended to `data/games.jsonl` with:

- players, seats, commanders, colors, final life / poison / commander damage, finishing place
- every turn (who, start, end), so turn lengths can be measured
- the full event log: each life, poison and commander-damage change with who tapped it, who it targeted, and the source of the damage

**Attribution rule:** when you lower someone else's life from your phone, the loss is credited to you as damage dealt. Commander damage always has an explicit source. Changes to your own life have no source. The **KO** goes to whoever last dealt attributed damage before the elimination.

The **Stats** page builds these from that file:

- per player: games, wins, win %, damage dealt, KOs, average turn time, favourite commander
- per commander: games, wins, win %
- per game (tap a recent game): life-over-time chart, standings, damage dealt, KOs, average turn
- **Export** downloads every game as JSON

### Design language

Dark slate background with a faint dot grid, calm and low-glare for long sessions. Big life numbers in Space Grotesk with fixed-width digits so they don't jump around. Labels and log entries in JetBrains Mono for the nerdy, terminal-ish feel. Each player gets one muted accent color (five of them echo the five mana colors), and that color carries across their tile, their lines in the chart and their entries in the log. Red is kept for danger only. Fonts and the QR library ship with the app, so it works with no internet.

## Architecture

```
server.js          Node http server: static files, JSON API, SSE, idle sweeper, stats
public/index.html  app shell
public/app.js      single-file vanilla JS client (hash routes: #/, #/s/CODE, #/stats, #/g/ID)
public/styles.css  design tokens + components
public/vendor/     qrcode-generator, fonts (see LICENSES.md)
data/              sessions.json (live sessions), games.jsonl (history) — gitignored
test/smoke.mjs     end-to-end API test
```

API: `POST /api/sessions` · `GET /api/sessions/:code` · `GET /api/sessions/:code/stream` (SSE) · `POST /api/sessions/:code/join` · `POST /api/sessions/:code/action` · `GET /api/stats` · `GET /api/games[/:id]` · `GET /api/info`

## Known limits & next steps

- **No accounts.** Stats group players by name (case-insensitive), so "Marco" and "marco" count as the same person but "Marco R." doesn't.
- **Trust model:** anyone with the code can change anything, which is fine among friends. Only the host can kick players or close the session.
- **Wake Lock & install-to-home-screen need HTTPS.** On plain LAN `http://` the screen may dim. Deploying (Render, Fly.io, Railway — one Node process, SSE works fine) or running behind `tailscale serve` / `cloudflared` gives you HTTPS.
- Ideas: commander tax & storm counters, a day/night toggle, dice/coin and "random player" tools, partner commanders (two commander-damage tracks), a per-pod head-to-head matrix, Scryfall commander autocomplete with art on the tiles, a PWA offline shell.
