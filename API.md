# Game Server API Specification

> Exchange project — turn-based peer-to-peer board game prototype.
> The server is a **scheduler + relay hub only**. It does NOT define your client's
> business data, does not judge wins/losses, and does not render anything.
> Data contracts between the two clients are negotiated client-to-client.

## 1. Transport

| Item | Value |
|---|---|
| Protocol | WebSocket (`RFC 6455`), text frames only |
| Encoding | UTF-8 JSON, one message per frame |
| Envelope | `{ "type": "<message type>", ...fields }` |
| Default endpoint | `ws://<server-host>:8080` |
| HTTP debug | `GET /api/rooms` → list of rooms (`roomId`, `state`, `players`, `turn`, `turnCount`) |
| HTTP helper | `GET /api/urls` → shareable client URLs (`localhost` + LAN IPs), shown by the web client as "send this to your opponent" |

Hardware clients (when they arrive) use the **exact same** WebSocket endpoint and
messages. The server never distinguishes client types — replacement is a pure
client-side swap.

## 2. Concepts

- **room**: one game session, 2 seats.
- **seat**: `'A'` (first mover, creator) or `'B'` (joiner). Your seat is assigned
  by the server and never changes within a room.
- **turn**: the seat currently holding the action right. Managed **exclusively**
  by the server. A `move` sent out of turn is rejected.
- **payload**: business data you and the opposing client agree on. The server
  stores it (for `move`) or forwards it (for `relay`) without interpretation.
- **state**: room lifecycle — `waiting` (not both seated) → `playing` → `over`.

## 3. Client → Server messages

### 3.1 `quick_match`
One-click matchmaking — the recommended flow (no room code to exchange).
The first requester waits (`match_waiting`); the next requester is paired with
them: the server creates a room, seats the waiter as `A` and the newcomer as
`B`, then sends `match_found` + `game_start` to both. No fields.

### 3.2 `cancel_match`
Leave the matchmaking queue (reply: `match_cancelled`). No fields.

### 3.3 `create_room`
Create a room (private/explicit mode). You are automatically seated as `A`.
No fields.

### 3.4 `join_room`
Join (or rejoin after disconnect) a room by id.
```json
{ "type": "join_room", "roomId": "1A2B3C", "preferSeat": "A" }
```
- `preferSeat` (optional, `'A'`/`'B'`): on reconnect, seat yourself back where
  you were if it is still free — prevents swapping colors with your opponent.
- When both seats are filled:
  - if no moves were made yet, the server resets (turn=`A`, turnCount=0,
    history=[]) and broadcasts `game_start`;
  - if moves were made (an interrupted game), the server sets `state=playing`
    and broadcasts **`game_resumed`** to both sides — the board, turn attribution
    and current mover are all preserved. Resume your game from there.
- Joining a not-yet-full room replies with `sync_state` so you can rebuild the
  board while waiting for the opponent to return.

Rooms with one empty seat are kept for **30 minutes** (env `RESUME_TIMEOUT_MS`),
then released: the remaining player receives `room_expired`.

### 3.5 `move`
The **only** server-gated channel. Use it for anything that consumes the turn
(placing a stone, an action, a declaration…).
```json
{ "type": "move", "payload": { "x": 7, "y": 8 } }
```
- `payload` is fully client-defined (the demo client uses `{x, y}`).
- Server checks: you are in a room, room state is `playing`, and it is your turn.
- On success the server increments `turnCount`, appends to `history`, flips the
  turn, and broadcasts `move_made` to **both** clients (including the sender).

### 3.6 `relay`
Blind data relay to your opponent. Zero server-side parsing.
```json
{ "type": "relay", "payload": { "any": "business data" } }
```
Use for chat, clock sync, proposals, emoticons, board themes — anything that
does not consume a turn. Opponent receives it as a `relay` event.

### 3.7 `game_over`
Report the end of the game. **The winner is decided by the clients**; the server
only records and announces it.
```json
{ "type": "game_over", "winner": "A", "reason": "five_in_row", "payload": { "x": 7, "y": 8 } }
```
- `winner`: `'A' | 'B' | null` (null = draw). Optional.
- `reason`, `payload`: free-form, relayed as-is. Optional. The demo client uses
  `five_in_row`, `board_full` and `resign` (resign = report the opponent as
  winner; no dedicated server message needed).

### 3.8 `rematch`
After `game_over`, request a restart **in the same room against the same
opponent**. No fields. When one side has requested, both receive `rematch_state`;
when both sides have requested, the server resets the room (turn=`A`,
turnCount=0, history=[]) and broadcasts `game_start` again. Rematch flags are
cleared whenever either seat disconnects or leaves.

### 3.9 `sync`
Request the room metadata snapshot (current turn, turnCount, full `move`
history). No fields. Server replies `sync_state`.

### 3.10 `leave`
Voluntarily leave your seat. No fields. The opponent gets `opponent_left`.

## 4. Server → Client messages

| type | fields | when |
|---|---|---|
| `match_waiting` | — | queued by `quick_match`, waiting for an opponent |
| `match_found` | `roomId`, `yourSeat` | paired by `quick_match` (immediately followed by `game_start`) |
| `match_cancelled` | — | reply to `cancel_match` |
| `room_created` | `roomId`, `yourSeat` | after `create_room` |
| `room_joined` | `roomId`, `yourSeat` | after `join_room` |
| `game_start` | `roomId`, `firstTurn` (`'A'` or `'B'`) | both seats filled, fresh game. **First mover alternates every game** within a room (quick-match rooms randomize game 1); render black/white from `firstTurn`, never from seat letters |
| `game_resumed` | `roomId`, `turn`, `turnCount`, `history` | both seats filled again after an interruption — replay `history` to rebuild the board and continue; `turn` is the seat to move |
| `room_expired` | `roomId` | the room's empty seat stayed empty past the keep-alive window (default 30 min); the room is released |
| `move_made` | `roomId`, `seat`, `payload`, `turnCount`, `nextTurn` | after every accepted `move`, to both clients |
| `relay` | `roomId`, `from`, `payload` | opponent sent a `relay` |
| `game_over` | `roomId`, `winner`, `reason`, `payload` | after any `game_over` report; broadcast exactly once (duplicate reports from both clients are deduped) |
| `rematch_state` | `roomId`, `requested` (`['A']`, `['B']` or `['A','B']`) | someone requested `rematch`; immediately followed by `game_start` when both have requested |
| `sync_state` | `room` (see §5) | reply to `sync`, or after joining a not-yet-full room |
| `opponent_left` | `roomId` | opponent disconnected or left |
| `left` | `roomId` | reply to `leave` |
| `error` | `code`, `message` | any rejected request |

### Error codes
| code | meaning |
|---|---|
| `BAD_JSON` | frame is not valid JSON |
| `BAD_TYPE` | missing `type` field |
| `UNKNOWN_TYPE` | unknown message type |
| `NOT_IN_ROOM` | you must `create_room`/`join_room` first |
| `ALREADY_IN_ROOM` | leave before creating/joining another room |
| `ROOM_NOT_FOUND` | no such room id |
| `ROOM_FULL` | both seats occupied |
| `NOT_PLAYING` | room is `waiting` or `over` |
| `NOT_OVER` | `rematch` requested before the game is over |
| `NOT_YOUR_TURN` | it is the opponent's turn |
| `NO_PAYLOAD` | `move` requires a `payload` field |
| `OPPONENT_OFFLINE` | `relay` with no opponent connected |
| `INTERNAL` | unexpected server error |

## 5. Room snapshot (`sync_state.room`)

```json
{
  "roomId": "1A2B3C",
  "state": "playing",
  "turn": "B",
  "turnCount": 12,
  "history": [
    { "seat": "A", "payload": { "x": 7, "y": 7 }, "turnCount": 1 },
    { "seat": "B", "payload": { "x": 8, "y": 8 }, "turnCount": 2 }
  ],
  "rematch": { "A": false, "B": false },
  "seats": { "A": true, "B": true }
}
```
Replay `history` in order to rebuild any board state. Payloads are yours to
interpret — the server only guarantees ordering and turn attribution.

## 6. Typical message flow

```
Client A                          Server                          Client B
   |-- quick_match ---------------->|                                |
   |<-- match_waiting --------------|                                |
   |                                |<------------- quick_match -----|
   |<-- match_found {A} + start ----|--- match_found {B} + start --->|
   |-- move {x,y} ----------------->|                                |
   |<-- move_made (seat:A,...) -----|--- move_made (seat:A,...) ---->|   (both boards update)
   |                                |<------------- move ------------|
   |<-- move_made (seat:B,...) -----|--- move_made (seat:B,...) ---->|
   |-- relay {chat:"gg"} ---------->|--- relay {from:A,...} -------->|
   |<--------------- game_over -----|<------------- game_over -------|   (either side declares)
```

### Room-code mode (explicit pairing)

```
Client A                          Server                          Client B
   |-- create_room ---------------->|                                |
   |<-- room_created {A} -----------|                                |
   |                                |<------------- join_room -------|
   |<-- game_start {firstTurn:A} ---|--- game_start {firstTurn:A} -->|
   |<--------------- move_made -----|<------------- move ------------|   (rejected: NOT_YOUR_TURN if B moved first)
   |-- move {x,y} ----------------->|                                |
   |<-- move_made (seat:A,...) -----|--- move_made (seat:A,...) ---->|
   |                                |<------------- move ------------|
   |<-- move_made ... --------------|--- move_made ... ------------->|
   |-- relay {chat:"gg"} ---------->|--- relay {from:A,...} -------->|
   |<--------------- game_over -----|<------------- game_over -------|   (either side declares)
```

## 7. Rules the server enforces (and nothing more)

1. **Turn order** — only the seat holding `turn` may `move`; server flips turn
   after each accepted move and tells both sides `nextTurn`.
2. **Room lifecycle** — `waiting → playing → over`; moves rejected outside
   `playing`.
3. **Two-seat consistency** — one connection per seat; reconnecting reclaims a
   free seat; opponent is notified of departures.
4. **Metadata integrity** — `turnCount` and ordered `history` are maintained
   server-side and available via `sync`.

Everything else — board validity, legality of a move beyond turn order, win
detection, timers, rendering — lives in the clients by design.
