# 对弈原型(国际交换项目)

跨电脑软件对弈原型:两台电脑各开一个网页客户端,通过服务器进行回合制对弈。
当前以五子棋(Gomoku)作为演示棋种——换任何回合制玩法,服务器代码零改动。

## 结构

```
utep-game/
├── server.js        # 服务器:回合调度 + 数据透传 + 局内元数据(依赖 ws + redis)
├── web/index.html   # 网页客户端(临时形态,单文件、零构建)
└── API.md           # 全部 API 及调用方法(提供给新加坡搭档的接口文档)
```

## 快速开始

```bash
npm install        # 安装 ws + redis 客户端
```

需要先启动 Redis(用于持久化房间元数据,详见下方「数据存储」一节):

```bash
sudo systemctl start redis   # 或 redis-server,视发行版而定
redis-cli ping                # 应返回 PONG
```

然后启动服务器:

```bash
npm start           # 默认 8080 端口,可用 PORT=3000 npm start 覆盖
```

然后:
1. 电脑 A 浏览器打开 `http://<服务器地址>:8080`,页面会自动连上服务器
2. 电脑 B(手机也行)打开同一网址,双方各点一次「⚡ 快速匹配」→ 自动配对开局,**先后手每局轮换**(首局随机,这把你后手下把就先手)
3. 轮到谁,谁点棋盘落子;双方棋盘实时同步,红圈高亮最后一手;胜负由客户端判定后上报;对局中可点「🏳 投降」认负(走 game_over,reason=resign,服务器零改动)
4. 人机对局:点「🤖 人机对局」即刻开局(你执黑先行,再来一局自动换边)。**电脑在浏览器本地运行,服务器零参与、断网也能玩**——符合"服务端不做 AI 决策"的分工红线。对局中可「↩ 悔棋」(不限次;轮到你时悔一整回合,电脑思考中只悔你那手)。难度旋钮:页面里 `AI_SLEEPY`(默认 0.35)为每手棋"打盹"概率——打盹时只防对方直接成五,活三/冲四级布局会漏防;调大更弱,设 0 全力以赴
5. 中途掉线/关页面:服务器保留棋局 30 分钟,重新打开页面**自动回到座位续弈**(房间号存本机 localStorage,`join_room` 带 `preferSeat` 坐回原位);网络闪断时页面会自动重连;对方掉线不误记战绩,房间超时释放才记「中断」
6. 一局结束后点「🔁 再来一局」同对手原地重开(双方都点即开局,无需刷新);或点「⚡ 换对手匹配」离席后自动重新匹配;对局中可「🏳 投降」
7. 战绩自动记录在本机浏览器(localStorage):胜/负/平/中断、执黑执白、对手昵称、手数、时长、胜率;昵称通过 relay 透传给对方
8. 想指定对手时,展开「高级」用房间号模式:一方创建,另一方加入

调试:`http://<服务器地址>:8080/api/rooms` 查看当前所有房间状态。

## 数据存储(Redis)

房间的「元数据」(轮次、落子历史、房间状态、再来一局标记等)存放在 Redis 里,**服务器进程重启、崩溃、`systemctl restart` 都不会丢失正在进行的对局**——重连后走 `game_resumed` 正常续弈。

WebSocket 连接本身(谁的 socket 坐在哪个座位)无法序列化进 Redis,只存在服务器进程的本地内存里。这意味着:
- 单机部署完全没问题,重连总能找到对应连接
- 若未来要多台服务器横向扩展,座位归属需要额外的会话粘滞(sticky session)方案,当前版本未实现

房间数据设有 Redis 原生过期时间(略长于 30 分钟保留期),即使服务器异常退出、保留计时器没能触发,Redis 也会自动清理过期房间。

默认连接本机 Redis(`redis://127.0.0.1:6379`),可用环境变量覆盖:

```bash
REDIS_URL=redis://your-redis-host:6379 npm start
```

## 设计要点(与任务书对应)

| 任务书要求 | 实现 |
|---|---|
| 控制行动权归属、防回合错乱 | `move` 是唯一强校验通道,非当前行动方直接拒收 `NOT_YOUR_TURN` |
| 执行数据透传、不做深度处理 | `relay` 消息原样转发,服务器零解析 |
| 管理局内元数据 | 房间状态 / 当前回合 / 手数 / 有序落子历史存于 Redis,`sync` 可随时拉取快照 |
| 客户端间自主协商数据契约 | 所有 `payload` 字段由两端客户端自行约定,服务器不理解内容 |
| 硬件平替沿用相同 API | 服务器不区分客户端类型,硬件届时直连同一 WebSocket 端点即可 |

人机对局为纯客户端功能:启发式评估(连五/活四/冲四/活三级别,攻防加权)+ 打盹降难机制 + 悔棋(落子栈实现),不改任何服务器接口,战绩带 🤖 标记。

## 给搭档的话

接口文档在 [API.md](API.md)(中英双语)。核心就三件事:
1. 连 `ws://<host>:8080`,用 JSON 消息通信(信封:`{"type": "...", ...}`)
2. 你需要对方传什么数据,直接和对方客户端约定进 `payload` / `relay`,服务器不管
3. 落子走 `move`(受回合管制),其余聊天/自定义信令走 `relay`(纯透传)

---

# Turn-Based Game Prototype (International Exchange Project)

A cross-computer turn-based game prototype: two computers each open a web
client and play through a shared server. Gomoku (五子棋) is currently used
as the demo game — swapping in any other turn-based game requires **zero**
server-side changes.

## Structure

```
utep-game/
├── server.js        # Server: turn scheduling + data relay + in-game metadata (depends on ws + redis)
├── web/index.html   # Web client (single file, zero build step, temporary form)
└── API.md           # Full API reference (bilingual, for the Singapore partner)
```

## Quick Start

```bash
npm install        # installs ws + the redis client
```

Redis must be running first (used to persist room metadata — see "Data
Storage" below):

```bash
sudo systemctl start redis   # or redis-server, depending on your distro
redis-cli ping                # should return PONG
```

Then start the server:

```bash
npm start           # port 8080 by default, override with PORT=3000 npm start
```

Then:
1. Computer A opens `http://<server-address>:8080` in a browser — the page
   auto-connects to the server.
2. Computer B (a phone works too) opens the same URL. Both click "⚡ 快速匹配"
   (Quick Match) once — they're auto-paired and the game starts. **First
   mover alternates every game** (randomized for game 1; whoever went second
   goes first next game).
3. Whoever's turn it is clicks a board intersection; both boards sync in
   real time, a red circle highlights the last move. Win/loss is judged
   client-side and reported to the server. Either side can click "🏳 投降"
   (Resign) mid-game (goes through `game_over`, `reason: resign` — zero
   server changes needed).
4. AI mode: click "🤖 人机对局" (vs AI) to start instantly (you play black/
   first move; sides auto-swap on rematch). **The AI runs entirely in the
   browser — the server is not involved at all, and it works offline** — in
   line with the "server never makes AI decisions" separation of concerns.
   Undo ("↩ 悔棋") is available anytime, unlimited uses (on your turn, undoes
   a full round; while the AI is "thinking," only undoes your own last move).
   Difficulty knob: `AI_SLEEPY` in the page (default `0.35`) is the
   per-move chance the AI "dozes off" — while dozing it only defends against
   an immediate five-in-a-row, missing open-three/four-level threats; raise
   it for a weaker AI, set to `0` for full strength.
5. Disconnect / closed tab mid-game: the server keeps the room for 30
   minutes; reopening the page **automatically rejoins your seat and resumes
   the game** (room ID is cached in `localStorage`; `join_room` includes
   `preferSeat` to reclaim your original seat). The page auto-reconnects on
   a network blip. An opponent disconnecting does not record an abandoned
   game — only a room timing out does.
6. After a game ends, click "🔁 再来一局" (Rematch) to restart in the same
   room against the same opponent (starts once both click, no refresh
   needed); or "⚡ 换对手匹配" (New Opponent) to leave and get auto-matched
   with someone new. Resign is available mid-game.
7. Match history is recorded automatically in the browser (`localStorage`):
   win/loss/draw/abandoned, which color you played, opponent nickname, move
   count, duration, win rate. Nicknames are exchanged via `relay`.
8. To play a specific person, expand "高级" (Advanced) for room-code mode:
   one side creates a room, the other joins with the code.

Debug: `http://<server-address>:8080/api/rooms` shows the current state of
all rooms.

## Data Storage (Redis)

Room **metadata** (turn, move history, room state, rematch flags, etc.) is
stored in Redis, so **a server process restart, crash, or
`systemctl restart` does not lose an in-progress game** — clients reconnect
and resume normally via `game_resumed`.

The WebSocket connections themselves (which socket occupies which seat)
cannot be serialized into Redis and live only in the server process's local
memory. This means:
- Single-server deployment works fine — reconnects always find the right
  live connection.
- Scaling to multiple server processes in the future would require an
  additional sticky-session scheme for seat ownership; this is not
  implemented in the current version.

Room keys carry a native Redis expiry (slightly longer than the 30-minute
keep-alive window), so even if the server exits abnormally before its own
expiry timer fires, Redis will still clean up stale rooms on its own.

Connects to local Redis by default (`redis://127.0.0.1:6379`); override with
an environment variable:

```bash
REDIS_URL=redis://your-redis-host:6379 npm start
```

## Design Notes (mapped to the project brief)

| Requirement | Implementation |
|---|---|
| Own turn ownership, prevent out-of-order play | `move` is the only strictly validated channel; an out-of-turn sender is rejected with `NOT_YOUR_TURN` |
| Relay data without deep processing | `relay` messages are forwarded verbatim; zero server-side parsing |
| Manage in-game metadata | Room state / current turn / move count / ordered move history live in Redis; `sync` fetches a snapshot at any time |
| Clients negotiate their own data contract | Every `payload` field is agreed between the two clients; the server never interprets it |
| Hardware replacements reuse the same API | The server never distinguishes client type — hardware connects to the same WebSocket endpoint when it's ready |

AI mode is a pure client-side feature: heuristic evaluation (five-in-a-row /
open-four / four / open-three tiers, weighted attack+defense) + a
"dozing" difficulty mechanism + undo (via a move stack) — it changes no
server interface, and match records are tagged with a 🤖 marker.

## Notes for the Partner

Full API reference is in [API.md](API.md) (bilingual). Three things matter most:
1. Connect to `ws://<host>:8080`, communicate with JSON messages (envelope:
   `{"type": "...", ...}`)
2. Whatever data you need from the other side, negotiate it directly with
   the other client into `payload` / `relay` — the server doesn't care
3. Moves that consume a turn go through `move` (turn-gated); everything else
   (chat, custom signaling) goes through `relay` (pure passthrough)
