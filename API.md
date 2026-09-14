# 游戏服务器接口文档

> 交换项目 —— 回合制双人对弈原型。
> 服务器**只**扮演「调度器 + 透传枢纽」的角色。它不定义客户端的业务数据,
> 不判定胜负,不做任何渲染。两端客户端之间自行协商数据契约。

## 1. 传输层

| 项目 | 值 |
|---|---|
| 协议 | WebSocket(`RFC 6455`),仅文本帧 |
| 编码 | UTF-8 JSON,每帧一条消息 |
| 信封格式 | `{ "type": "<消息类型>", ...其他字段 }` |
| 默认端点 | `ws://<server-host>:8080` |
| HTTP 调试接口 | `GET /api/rooms` → 房间列表(`roomId`、`state`、`players`、`turn`、`turnCount`) |

硬件客户端(未来接入时)使用**完全相同**的 WebSocket 端点与消息格式。服务器不区分客户端类型——替换硬件只是纯客户端侧的改动。

## 2. 核心概念

- **room(房间)**:一局对弈,固定 2 个座位。
- **seat(座位)**:`'A'`(先手,创建者)或 `'B'`(加入者)。座位由服务器分配,房间存续期间不变。
- **turn(行动权)**:当前持有行动权的座位。**完全**由服务器管理,非当前行动方发来的 `move` 会被拒绝。
- **payload(载荷)**:你与对方客户端自行约定的业务数据。服务器仅存储(`move`)或转发(`relay`),不做任何解析。
- **state(房间状态)**:`waiting`(未满员)→ `playing`(对局中)→ `over`(已结束)。

## 3. 数据存储

房间元数据(轮次、落子历史、状态、再来一局标记等)持久化在 **Redis** 中——服务器进程重启不会丢失正在进行的对局,重连后走 `game_resumed` 正常续弈。

WebSocket 连接本身(实际 socket)只存在于当前服务器进程内存中,不落 Redis;这对单机部署没有影响,多机横向扩展时需要额外的会话粘滞方案(当前版本未实现)。

房间在 Redis 中设有过期时间(略长于下方的 30 分钟保留窗口),即使保留计时器因进程异常退出而未触发,过期房间也会被 Redis 自动清理。

## 4. 客户端 → 服务器 消息

### 4.1 `quick_match`(快速匹配)
一键匹配——推荐流程,无需交换房间号。
先发起者进入等待(收到 `match_waiting`);下一个发起者与其配对:服务器创建房间,先等待者坐 `A`,后来者坐 `B`,随后向双方发送 `match_found` + `game_start`。无需字段。

### 4.2 `cancel_match`(取消匹配)
退出匹配队列(回复:`match_cancelled`)。无需字段。

### 4.3 `create_room`(创建房间)
创建房间(私密/显式模式)。你将自动坐上 `A` 座位。无需字段。

### 4.4 `join_room`(加入房间)
通过房间号加入(或断线后重新加入)房间。
```json
{ "type": "join_room", "roomId": "1A2B3C", "preferSeat": "A" }
```
- `preferSeat`(可选,`'A'`/`'B'`):断线重连时,若原座位仍空则坐回原位——避免与对手换边。
- 双方座位都坐满时:
  - 若尚未落过子,服务器重置对局(turn=`A`,turnCount=0,history=[])并广播 `game_start`;
  - 若已有落子记录(中断过的对局),服务器将 `state` 设为 `playing`,并向双方广播 **`game_resumed`**——棋盘、行棋归属与当前行动方均被保留,从那里继续。
- 加入尚未满员的房间会收到 `sync_state`,可据此在等待对手期间重建棋盘。

缺一座位的房间默认保留 **30 分钟**(环境变量 `RESUME_TIMEOUT_MS` 可调),超时后释放,剩余玩家会收到 `room_expired`。

### 4.5 `move`(落子)
**唯一**受服务器强校验的通道。用于任何消耗行动权的操作(落子、动作、宣告……)。
```json
{ "type": "move", "payload": { "x": 7, "y": 8 } }
```
- `payload` 完全由客户端自定义(演示客户端用 `{x, y}`)。
- 服务器校验:你已在房间中、房间状态为 `playing`、且轮到你行动。
- 校验通过后,服务器递增 `turnCount`、追加到 `history`、翻转行动权,并向**双方**(含发送者)广播 `move_made`。

### 4.6 `relay`(透传)
向对手盲转发数据,服务器零解析。
```json
{ "type": "relay", "payload": { "any": "business data" } }
```
可用于聊天、时钟同步、提议、表情、棋盘主题——任何不消耗行动权的内容。对方会收到一条 `relay` 事件。

### 4.7 `game_over`(对局结束)
上报对局结束。**胜负由客户端判定**;服务器只负责记录与广播。
```json
{ "type": "game_over", "winner": "A", "reason": "five_in_row", "payload": { "x": 7, "y": 8 } }
```
- `winner`:`'A' | 'B' | null`(null 表示平局)。可选。
- `reason`、`payload`:自由格式,原样转发。可选。演示客户端使用 `five_in_row`、`board_full`、`resign`(投降 = 上报对方获胜,无需专门的服务器消息)。

### 4.8 `rematch`(再来一局)
`game_over` 之后,请求**在同一房间与同一对手**重开一局。无需字段。一方请求后,双方都会收到 `rematch_state`;双方都请求后,服务器重置房间(turn=`A`,turnCount=0,history=[])并再次广播 `game_start`。任一座位断线或离开都会清空再来一局标记。

### 4.9 `sync`(同步)
请求房间元数据快照(当前行动权、turnCount、完整 `move` 历史)。无需字段。服务器回复 `sync_state`。

### 4.10 `leave`(离席)
主动离开座位。无需字段。对手会收到 `opponent_left`。

## 5. 服务器 → 客户端 消息

| 类型 | 字段 | 触发时机 |
|---|---|---|
| `match_waiting` | — | `quick_match` 后进入等待队列 |
| `match_found` | `roomId`, `yourSeat` | `quick_match` 配对成功(紧接着会收到 `game_start`) |
| `match_cancelled` | — | 回复 `cancel_match` |
| `room_created` | `roomId`, `yourSeat` | `create_room` 之后 |
| `room_joined` | `roomId`, `yourSeat` | `join_room` 之后 |
| `game_start` | `roomId`, `firstTurn`(`'A'` 或 `'B'`) | 双方座位坐满,全新对局。**先手每局在房间内轮换**(快速匹配房间首局随机);请根据 `firstTurn` 渲染黑白方,不要依据座位字母 |
| `game_resumed` | `roomId`, `turn`, `turnCount`, `history` | 中断后双方座位重新坐满——回放 `history` 重建棋盘并继续;`turn` 为待行动座位 |
| `room_expired` | `roomId` | 房间空缺座位超过保留窗口(默认 30 分钟),房间已释放 |
| `move_made` | `roomId`, `seat`, `payload`, `turnCount`, `nextTurn` | 每次落子被接受后,发给双方客户端 |
| `relay` | `roomId`, `from`, `payload` | 对手发送了 `relay` |
| `game_over` | `roomId`, `winner`, `reason`, `payload` | 任一方上报 `game_over` 后广播(去重,只广播一次) |
| `rematch_state` | `roomId`, `requested`(`['A']`、`['B']` 或 `['A','B']`) | 有人请求 `rematch`;双方都请求后紧接着收到 `game_start` |
| `sync_state` | `room`(见第 6 节) | 回复 `sync`,或加入尚未满员的房间后 |
| `opponent_left` | `roomId` | 对手断线或离席 |
| `left` | `roomId` | 回复 `leave` |
| `error` | `code`, `message` | 任何被拒绝的请求 |

### 错误码

| 代码 | 含义 |
|---|---|
| `BAD_JSON` | 帧内容不是合法 JSON |
| `BAD_TYPE` | 缺少 `type` 字段 |
| `UNKNOWN_TYPE` | 未知的消息类型 |
| `NOT_IN_ROOM` | 需先 `create_room`/`join_room` |
| `ALREADY_IN_ROOM` | 需先 `leave` 才能创建/加入其他房间 |
| `ROOM_NOT_FOUND` | 房间号不存在 |
| `ROOM_FULL` | 两个座位都已占用 |
| `NOT_PLAYING` | 房间处于 `waiting` 或 `over` 状态 |
| `NOT_OVER` | 对局尚未结束就请求 `rematch` |
| `NOT_YOUR_TURN` | 当前是对方的行动权 |
| `NO_PAYLOAD` | `move` 缺少 `payload` 字段 |
| `OPPONENT_OFFLINE` | `relay` 时对手未连接 |
| `INTERNAL` | 服务器意外错误 |

## 6. 房间快照(`sync_state.room`)

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
依序回放 `history` 即可重建任意棋盘状态。payload 内容由你自行解释——服务器只保证顺序与行动权归属正确。

## 7. 典型消息时序

```
客户端 A                          服务器                          客户端 B
   |-- quick_match ---------------->|                                |
   |<-- match_waiting --------------|                                |
   |                                |<------------- quick_match -----|
   |<-- match_found {A} + start ----|--- match_found {B} + start --->|
   |-- move {x,y} ----------------->|                                |
   |<-- move_made (seat:A,...) -----|--- move_made (seat:A,...) ---->|   (双方棋盘更新)
   |                                |<------------- move ------------|
   |<-- move_made (seat:B,...) -----|--- move_made (seat:B,...) ---->|
   |-- relay {chat:"gg"} ---------->|--- relay {from:A,...} -------->|
   |<--------------- game_over -----|<------------- game_over -------|   (任一方判定后上报)
```

### 房间号模式(显式配对)

```
客户端 A                          服务器                          客户端 B
   |-- create_room ---------------->|                                |
   |<-- room_created {A} -----------|                                |
   |                                |<------------- join_room -------|
   |<-- game_start {firstTurn:A} ---|--- game_start {firstTurn:A} -->|
   |<--------------- move_made -----|<------------- move ------------|   (若 B 先落子会被拒:NOT_YOUR_TURN)
   |-- move {x,y} ----------------->|                                |
   |<-- move_made (seat:A,...) -----|--- move_made (seat:A,...) ---->|
   |                                |<------------- move ------------|
   |<-- move_made ... --------------|--- move_made ... ------------->|
   |-- relay {chat:"gg"} ---------->|--- relay {from:A,...} -------->|
   |<--------------- game_over -----|<------------- game_over -------|   (任一方判定后上报)
```

## 8. 服务器强制执行的规则(仅此而已)

1. **行动顺序**——只有持有 `turn` 的座位才能 `move`;每次落子被接受后服务器翻转行动权,并把 `nextTurn` 告知双方。
2. **房间生命周期**——`waiting → playing → over`;`playing` 状态之外的落子会被拒绝。
3. **两座位一致性**——每个座位对应一个连接;重连会抢占空座位;对手离开会收到通知。
4. **元数据完整性**——`turnCount` 与有序的 `history` 由服务器维护(存于 Redis),可随时通过 `sync` 获取。

除此之外的一切——棋盘合法性、行动权以外的走法合法性、胜负判定、计时器、渲染——按设计均由客户端各自负责。

---

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

## 3. Data Storage

Room metadata (turn, move history, state, rematch flags, etc.) is persisted
in **Redis** — a server process restart does not lose an in-progress game;
clients reconnect and resume normally via `game_resumed`.

The WebSocket connection itself (the live socket) exists only in the current
server process's memory and is never written to Redis; this has no impact on
a single-server deployment, but scaling to multiple server processes would
require an additional sticky-session scheme (not implemented in the current
version).

Rooms carry a Redis expiry (slightly longer than the 30-minute keep-alive
window below), so even if the keep-alive timer fails to fire due to an
abnormal process exit, expired rooms are still cleaned up automatically by
Redis.

## 4. Client → Server messages

### 4.1 `quick_match`
One-click matchmaking — the recommended flow (no room code to exchange).
The first requester waits (`match_waiting`); the next requester is paired with
them: the server creates a room, seats the waiter as `A` and the newcomer as
`B`, then sends `match_found` + `game_start` to both. No fields.

### 4.2 `cancel_match`
Leave the matchmaking queue (reply: `match_cancelled`). No fields.

### 4.3 `create_room`
Create a room (private/explicit mode). You are automatically seated as `A`.
No fields.

### 4.4 `join_room`
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

### 4.5 `move`
The **only** server-gated channel. Use it for anything that consumes the turn
(placing a stone, an action, a declaration…).
```json
{ "type": "move", "payload": { "x": 7, "y": 8 } }
```
- `payload` is fully client-defined (the demo client uses `{x, y}`).
- Server checks: you are in a room, room state is `playing`, and it is your turn.
- On success the server increments `turnCount`, appends to `history`, flips the
  turn, and broadcasts `move_made` to **both** clients (including the sender).

### 4.6 `relay`
Blind data relay to your opponent. Zero server-side parsing.
```json
{ "type": "relay", "payload": { "any": "business data" } }
```
Use for chat, clock sync, proposals, emoticons, board themes — anything that
does not consume a turn. Opponent receives it as a `relay` event.

### 4.7 `game_over`
Report the end of the game. **The winner is decided by the clients**; the server
only records and announces it.
```json
{ "type": "game_over", "winner": "A", "reason": "five_in_row", "payload": { "x": 7, "y": 8 } }
```
- `winner`: `'A' | 'B' | null` (null = draw). Optional.
- `reason`, `payload`: free-form, relayed as-is. Optional. The demo client uses
  `five_in_row`, `board_full` and `resign` (resign = report the opponent as
  winner; no dedicated server message needed).

### 4.8 `rematch`
After `game_over`, request a restart **in the same room against the same
opponent**. No fields. When one side has requested, both receive `rematch_state`;
when both sides have requested, the server resets the room (turn=`A`,
turnCount=0, history=[]) and broadcasts `game_start` again. Rematch flags are
cleared whenever either seat disconnects or leaves.

### 4.9 `sync`
Request the room metadata snapshot (current turn, turnCount, full `move`
history). No fields. Server replies `sync_state`.

### 4.10 `leave`
Voluntarily leave your seat. No fields. The opponent gets `opponent_left`.

## 5. Server → Client messages

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
| `sync_state` | `room` (see §6) | reply to `sync`, or after joining a not-yet-full room |
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

## 6. Room snapshot (`sync_state.room`)

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

## 7. Typical message flow

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

## 8. Rules the server enforces (and nothing more)

1. **Turn order** — only the seat holding `turn` may `move`; server flips turn
   after each accepted move and tells both sides `nextTurn`.
2. **Room lifecycle** — `waiting → playing → over`; moves rejected outside
   `playing`.
3. **Two-seat consistency** — one connection per seat; reconnecting reclaims a
   free seat; opponent is notified of departures.
4. **Metadata integrity** — `turnCount` and ordered `history` are maintained
   server-side (in Redis) and available via `sync`.

Everything else — board validity, legality of a move beyond turn order, win
detection, timers, rendering — lives in the clients by design.
