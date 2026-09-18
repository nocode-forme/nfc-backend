/**
 * 对弈原型服务器(内存版)
 * 职责:回合制调度 + 数据透传 + 局内元数据维护
 * 非职责:AI 决策、胜负判定、渲染、业务数据格式定义(全部由客户端自理)
 *
 * 存储说明:
 *   房间「元数据」(turn/history/state/rematch/...)和 WebSocket 连接引用
 *   现在都只存在本进程内存里(一个 Map)。没有外部依赖、没有网络往返。
 *
 *   代价:server.js 进程重启/崩溃/pm2 restart 会丢失所有正在进行的对局
 *   ——这对这个原型是可接受的(房间本来就设计成一次性的、可随时重开)。
 *   如果以后要跨进程扩容或要求重启不丢局,再把 rooms 这个 Map 换成外部
 *   存储(Redis 之类)即可,其余代码不用大改。
 *
 *   WebSocket 连接本身天然只属于当前进程,所以「谁的 socket 坐在哪个座位」
 *   放在本地内存的 socketsByRoom 里,这一点和之前一样没变。
 *
 * 通信:WebSocket + JSON,消息统一形如 { "type": "...", ...字段 }
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { GameRules } = require('./game_rules');

const PORT = process.env.PORT || 8080;
// 断线后房间保留多久(毫秒):期间重新入座可继续没下完的局,超时则释放房间
const RESUME_TIMEOUT_MS = Number(process.env.RESUME_TIMEOUT_MS || 30 * 60 * 1000);

// 目前支持的棋类。每条连接建立后必须先选择其中之一,选定后本次连接
// 生命周期内不可更改;房间也会带上这个字段,加入房间时要求棋类一致。
const VALID_GAME_TYPES = ['wuziqi', 'xiangqi'];

// ---------------- 棋类规则(合法性复核,与回合归属校验分开) ----------------
const gameRules = new GameRules();

// ---------------- 房间模型(元数据 + socket 引用都在本地内存) ----------------
// room 结构:
// {
//   id, gameType: 'wuziqi'|'xiangqi', turn: 'A'|'B'|null, turnCount,
//   history: [{seat,payload,turnCount}],
//   state: 'waiting'|'playing'|'over',
//   rematch: { A: bool, B: bool },
//   firstMover: 'A'|'B',
//   seatsOccupied: { A: bool, B: bool },  // 只记录"是否有人坐",不存 ws 本身
//   createdAt
// }
const rooms = new Map(); // roomId -> room object
//
// socketsByRoom: Map<roomId, { A: ws|null, B: ws|null }>
const socketsByRoom = new Map();

function newRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function saveRoom(room) {
  rooms.set(room.id, room);
}

function deleteRoom(roomId) {
  rooms.delete(roomId);
  socketsByRoom.delete(roomId);
}

// 统一 get → 交给回调修改 → save 的流程,省去每个 handler 里重复的
// await getRoom / await saveRoom 配对(也避免漏 save 的低级错误)。
// fn 返回 false 时视为"提前中止、不落盘"(例如校验失败提前 return 的场景)。
async function withRoom(roomId, fn) {
  const room = await getRoom(roomId);
  if (!room) return null;
  const result = await fn(room);
  if (result !== false) await saveRoom(room);
  return room;
}

function getSockets(roomId) {
  if (!socketsByRoom.has(roomId)) socketsByRoom.set(roomId, { A: null, B: null });
  return socketsByRoom.get(roomId);
}

async function joinSeat(room, ws, seat) {
  if (room._resumeTimer) {
    clearTimeout(room._resumeTimer);
    room._resumeTimer = null;
  }
  const sockets = getSockets(room.id);
  sockets[seat] = ws;
  room.seatsOccupied = room.seatsOccupied || { A: false, B: false };
  room.seatsOccupied[seat] = true;
  ws._roomId = room.id;
  ws._seat = seat;
  await saveRoom(room);
}

// 有人离座后启动保留计时:超时仍缺人才真正释放房间
// 这个计时器只存在于本进程内存中——如果服务器在计时期间重启,计时会丢失,
// 但房间元数据本来也只在内存里,重启同样会清空,所以两者是一致的,不存在
// "计时器丢了但房间还占着内存不释放"的不一致情况。
const expiryTimers = new Map(); // roomId -> Timeout

function armExpiry(room) {
  const existing = expiryTimers.get(room.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    const current = getRoom(room.id);
    if (!current) return;
    const sockets = getSockets(room.id);
    if (!current.seatsOccupied.A || !current.seatsOccupied.B) {
      const rest = sockets.A || sockets.B;
      if (rest) send(rest, 'room_expired', { roomId: room.id });
      deleteRoom(room.id);
      expiryTimers.delete(room.id);
      console.log(`[room ${room.id}] expired (seat empty over ${RESUME_TIMEOUT_MS}ms)`);
    }
  }, RESUME_TIMEOUT_MS);
  expiryTimers.set(room.id, timer);
}

async function leaveSeat(ws) {
  const roomId = ws._roomId;
  if (!roomId) return null;
  const room = await getRoom(roomId);
  const sockets = getSockets(roomId);
  if (sockets[ws._seat] === ws) sockets[ws._seat] = null;
  if (room) {
    room.seatsOccupied[ws._seat] = false;
    await saveRoom(room);
  }
  ws._roomId = null;
  ws._seat = null;
  return room;
}

const opponentSeat = (seat) => (seat === 'A' ? 'B' : 'A');

// ---------------- 消息工具 ----------------
function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcastToRoom(roomId, type, data = {}) {
  const sockets = getSockets(roomId);
  for (const seat of ['A', 'B']) send(sockets[seat], type, data);
}

function snapshot(room) {
  return {
    roomId: room.id,
    gameType: room.gameType,
    state: room.state,
    turn: room.turn,
    turnCount: room.turnCount,
    history: room.history,
    rematch: room.rematch,
    seats: { A: !!room.seatsOccupied.A, B: !!room.seatsOccupied.B },
  };
}

// ---------------- HTTP:托管网页客户端 ----------------
// 统一的静态文件返回逻辑,避免每个路由重复一遍 readFile + 错误处理 + 响应头
function serveFile(res, relPath, errMsg) {
  const file = path.join(__dirname, 'web', relPath);
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500);
      return res.end(errMsg);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// 通用静态文件回退:client.js、样式、图片等资源都从这里兜底,
// 不用像上面那样每加一个文件就手写一条路由。做了两件安全相关的事:
//   1. 用 path.normalize + startsWith 校验解析后的路径仍在 web/ 目录内,
//      防止 ../../etc/passwd 这类路径穿越
//   2. 按后缀给出合适的 Content-Type,不认识的后缀退回 octet-stream
const STATIC_MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const webRoot = path.join(__dirname, 'web');
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.normalize(path.join(webRoot, urlPath));
  if (!filePath.startsWith(webRoot)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/landing.html') {
    return serveFile(res, 'landing.html', 'landing page missing');
  }
  if (req.url === '/demo' || req.url === '/index.html') {
    return serveFile(res, 'index.html', 'client file missing');
  }
  if (req.url.startsWith('/calibration.html')) {
    // startsWith 而非精确匹配:calibration.html 会带 ?mode=pvp/ai 查询参数
    return serveFile(res, 'calibration.html', 'calibration page missing');
  }
  if (req.url === '/api/rooms') {
    // 调试用:列出内存里所有房间
    const list = [];
    for (const r of rooms.values()) {
      list.push({
        roomId: r.id,
        gameType: r.gameType,
        state: r.state,
        players: (r.seatsOccupied.A ? 1 : 0) + (r.seatsOccupied.B ? 1 : 0),
        turn: r.turn,
        turnCount: r.turnCount,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }
  serveStatic(req, res);
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  // 本次连接尚未选择棋类;必须先发 select_game 选定后才能创建/加入房间、快速匹配。
  // 一旦选定就锁定,不允许中途更改(想换棋类需要断线重连)。
  ws._gameType = null;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, 'error', { code: 'BAD_JSON', message: '消息不是合法 JSON' });
    }
    if (!msg || typeof msg.type !== 'string') {
      return send(ws, 'error', { code: 'BAD_TYPE', message: '缺少 type 字段' });
    }
    try {
      await handle(ws, msg);
    } catch (err) {
      console.error('handle error:', err);
      send(ws, 'error', { code: 'INTERNAL', message: String(err.message || err) });
    }
  });

  ws.on('close', async () => {
    const qi = waitingQueue.indexOf(ws);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    const roomId = ws._roomId;
    const room = await leaveSeat(ws);
    if (!room) return;
    const sockets = getSockets(roomId);
    const other = sockets.A || sockets.B;
    if (other) {
      send(other, 'opponent_left', { roomId: room.id });
      if (room.state === 'playing') room.state = 'waiting';
      room.rematch = { A: false, B: false };
      await saveRoom(room);
      armExpiry(room);
    } else {
      await deleteRoom(room.id);
    }
  });
});

// ----快速匹配
const waitingQueue = [];

async function handleQuickMatch(ws) {
  if (ws._roomId) {
    return send(ws, 'error', { code: 'ALREADY_IN_ROOM', message: '已在房间中,请先 leave' });
  }
  if (!requireGameType(ws)) return;
  if (waitingQueue.includes(ws)) {
    return send(ws, 'match_waiting', {});
  }
  // 只和选了同一棋类的人配对。棋类不同但仍有效的候选者要放回队首,
  // 保持它们原本的排队顺序,不能被这次匹配悄悄跳过。
  let partner = null;
  const skipped = [];
  while (waitingQueue.length) {
    const cand = waitingQueue.shift();
    if (cand.readyState !== cand.OPEN || cand._roomId) continue; // 失效连接,直接丢弃
    if (cand._gameType !== ws._gameType) {
      skipped.push(cand);
      continue;
    }
    partner = cand;
    break;
  }
  if (skipped.length) waitingQueue.unshift(...skipped);
  if (!partner) {
    waitingQueue.push(ws);
    return send(ws, 'match_waiting', {});
  }
  const room = {
    id: newRoomId(),
    gameType: ws._gameType,
    turn: null,
    turnCount: 0,
    history: [],
    state: 'waiting',
    rematch: { A: false, B: false },
    firstMover: Math.random() < 0.5 ? 'A' : 'B',
    seatsOccupied: { A: false, B: false },
    createdAt: Date.now(),
  };
  await saveRoom(room);
  await joinSeat(room, partner, 'A');
  await joinSeat(room, ws, 'B');
  send(partner, 'match_found', { roomId: room.id, yourSeat: 'A', gameType: room.gameType });
  send(ws, 'match_found', { roomId: room.id, yourSeat: 'B', gameType: room.gameType });
  await startNewGame(room);
  console.log(`[room ${room.id}] quick match: A+B paired`);
}

function handleCancelMatch(ws) {
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
  send(ws, 'match_cancelled', {});
}

async function handle(ws, msg) {
  switch (msg.type) {
    case 'select_game':
      return handleSelectGame(ws, msg);
    case 'quick_match':
      return handleQuickMatch(ws);
    case 'cancel_match':
      return handleCancelMatch(ws);
    case 'create_room':
      return handleCreate(ws);
    case 'join_room':
      return handleJoin(ws, msg);
    case 'move':
      return handleMove(ws, msg);
    case 'relay':
      return handleRelay(ws, msg);
    case 'game_over':
      return handleGameOver(ws, msg);
    case 'rematch':
      return handleRematch(ws);
    case 'sync':
      return handleSync(ws);
    case 'leave':
      return handleLeave(ws);
    default:
      return send(ws, 'error', { code: 'UNKNOWN_TYPE', message: `未知消息类型: ${msg.type}` });
  }
}

// 选棋类是进房间前的前置步骤:未选择时拒绝一切创建/加入/匹配请求。
function requireGameType(ws) {
  if (!ws._gameType) {
    send(ws, 'error', { code: 'GAME_NOT_SELECTED', message: '请先发送 select_game 选择棋类(wuziqi/xiangqi)' });
    return false;
  }
  return true;
}

function handleSelectGame(ws, msg) {
  if (ws._gameType) {
    return send(ws, 'error', {
      code: 'GAME_ALREADY_SELECTED',
      message: `本次连接已选择棋类:${ws._gameType},不可更改(如需更换请重新连接)`,
    });
  }
  const gameType = msg.gameType;
  if (!VALID_GAME_TYPES.includes(gameType)) {
    return send(ws, 'error', {
      code: 'BAD_GAME_TYPE',
      message: `不支持的棋类:${gameType},可选:${VALID_GAME_TYPES.join('/')}`,
    });
  }
  ws._gameType = gameType;
  send(ws, 'game_selected', { gameType });
}

async function handleCreate(ws) {
  if (ws._roomId) {
    return send(ws, 'error', { code: 'ALREADY_IN_ROOM', message: '已在房间中,请先 leave' });
  }
  if (!requireGameType(ws)) return;
  const room = {
    id: newRoomId(),
    gameType: ws._gameType,
    turn: null,
    turnCount: 0,
    history: [],
    state: 'waiting',
    rematch: { A: false, B: false },
    firstMover: 'A',
    seatsOccupied: { A: false, B: false },
    createdAt: Date.now(),
  };
  await saveRoom(room);
  await joinSeat(room, ws, 'A');
  send(ws, 'room_created', { roomId: room.id, yourSeat: 'A', gameType: room.gameType });
  console.log(`[room ${room.id}] created by seat A`);
}

async function handleJoin(ws, msg) {
  if (ws._roomId) {
    return send(ws, 'error', { code: 'ALREADY_IN_ROOM', message: '已在房间中,请先 leave' });
  }
  if (!requireGameType(ws)) return;
  const room = await getRoom(String(msg.roomId || '').toUpperCase());
  if (!room) return send(ws, 'error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' });
  if (room.gameType !== ws._gameType) {
    return send(ws, 'error', {
      code: 'GAME_TYPE_MISMATCH',
      message: `该房间是 ${room.gameType} 房间,你选择的是 ${ws._gameType},无法加入`,
    });
  }

  const prefer = msg.preferSeat === 'A' || msg.preferSeat === 'B' ? msg.preferSeat : null;
  const freeSeat =
    prefer && !room.seatsOccupied[prefer] ? prefer : room.seatsOccupied.A ? (room.seatsOccupied.B ? null : 'B') : 'A';
  if (!freeSeat) return send(ws, 'error', { code: 'ROOM_FULL', message: '房间已满' });

  await joinSeat(room, ws, freeSeat);
  send(ws, 'room_joined', { roomId: room.id, yourSeat: freeSeat, gameType: room.gameType });

  const both = room.seatsOccupied.A && room.seatsOccupied.B;
  if (both && room.state !== 'over') {
    room.rematch = { A: false, B: false };
    if (room.turnCount > 0) {
      room.state = 'playing';
      await saveRoom(room);
      broadcastToRoom(room.id, 'game_resumed', {
        roomId: room.id,
        turn: room.turn,
        turnCount: room.turnCount,
        history: room.history,
      });
      console.log(`[room ${room.id}] game resumed at move ${room.turnCount}, turn=${room.turn}`);
    } else {
      await startNewGame(room);
    }
  } else {
    send(ws, 'sync_state', { room: snapshot(room) });
  }
}

async function startNewGame(room) {
  room.turn = room.firstMover;
  room.turnCount = 0;
  room.history = [];
  room.rematch = { A: false, B: false };
  room.state = 'playing';
  const nextFirstMover = opponentSeat(room.firstMover);
  await saveRoom(room);
  broadcastToRoom(room.id, 'game_start', { roomId: room.id, firstTurn: room.firstMover });
  console.log(`[room ${room.id}] game start, first mover = ${room.firstMover}`);
  room.firstMover = nextFirstMover;
  await saveRoom(room);
}

async function handleMove(ws, msg) {
  const roomId = ws._roomId;
  if (!roomId) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });

  let record = null;
  const room = await withRoom(roomId, (room) => {
    if (room.state !== 'playing') {
      send(ws, 'error', { code: 'NOT_PLAYING', message: `当前房间状态为 ${room.state},不能落子` });
      return false; // 校验失败,不落盘
    }
    if (room.turn !== ws._seat) {
      send(ws, 'error', { code: 'NOT_YOUR_TURN', message: `当前行动方是 ${room.turn}` });
      return false;
    }
    if (msg.payload === undefined) {
      send(ws, 'error', { code: 'NO_PAYLOAD', message: 'move 需要 payload 字段' });
      return false;
    }
    // 合法性复核:是否轮到你、房间状态是否 playing —— 上面已经查过;
    // 这一步棋本身站不站得住脚,交给 game_rules.js 判断
    const legality = gameRules.isLegal(room, ws._seat, msg.payload);
    if (!legality.legal) {
      send(ws, 'error', { code: 'ILLEGAL', message: legality.message || '不合法的落子' });
      return false;
    }
    record = { seat: ws._seat, payload: msg.payload, turnCount: room.turnCount + 1 };
    room.history.push(record);
    room.turnCount += 1;
    room.turn = opponentSeat(room.turn);
  });
  if (!room) return send(ws, 'error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' });
  if (!record) return; // 校验已在回调里发送了具体 error

  broadcastToRoom(room.id, 'move_made', {
    roomId: room.id,
    seat: record.seat,
    payload: record.payload,
    turnCount: record.turnCount,
    nextTurn: room.turn,
  });
}

function handleRelay(ws, msg) {
  const roomId = ws._roomId;
  if (!roomId) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  const sockets = getSockets(roomId);
  const to = sockets[opponentSeat(ws._seat)];
  if (!to) return send(ws, 'error', { code: 'OPPONENT_OFFLINE', message: '对方不在线' });
  send(to, 'relay', { roomId, from: ws._seat, payload: msg.payload });
}

async function handleGameOver(ws, msg) {
  const roomId = ws._roomId;
  if (!roomId) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });

  let alreadyOver = false;
  const room = await withRoom(roomId, (room) => {
    if (room.state === 'over') { alreadyOver = true; return false; } // 去重,不重复广播/落盘
    room.state = 'over';
    room.rematch = { A: false, B: false };
  });
  if (!room) return send(ws, 'error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' });
  if (alreadyOver) return;

  broadcastToRoom(room.id, 'game_over', {
    roomId: room.id,
    winner: msg.winner ?? null,
    reason: msg.reason ?? 'client_declared',
    payload: msg.payload,
  });
  console.log(`[room ${room.id}] game over, winner=${msg.winner ?? '-'}`);
}

async function handleRematch(ws) {
  const roomId = ws._roomId;
  if (!roomId) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });

  let notOver = false;
  const room = await withRoom(roomId, (room) => {
    if (room.state !== 'over') { notOver = true; return false; }
    room.rematch[ws._seat] = true;
  });
  if (!room) return send(ws, 'error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' });
  if (notOver) return send(ws, 'error', { code: 'NOT_OVER', message: '对局尚未结束,不能请求再来一局' });

  broadcastToRoom(room.id, 'rematch_state', {
    roomId: room.id,
    requested: ['A', 'B'].filter((s) => room.rematch[s]),
  });
  if (room.rematch.A && room.rematch.B) {
    await startNewGame(room);
    console.log(`[room ${room.id}] rematch accepted, game restarts`);
  }
}

async function handleSync(ws) {
  const roomId = ws._roomId;
  if (!roomId) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  const room = await getRoom(roomId);
  if (!room) return send(ws, 'error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' });
  send(ws, 'sync_state', { room: snapshot(room) });
}

async function handleLeave(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const room = await leaveSeat(ws);
  if (!room) return;
  room.rematch = { A: false, B: false };
  await saveRoom(room);
  send(ws, 'left', { roomId: room.id });
  const sockets = getSockets(roomId);
  const other = sockets.A || sockets.B;
  if (other) {
    send(other, 'opponent_left', { roomId: room.id });
    armExpiry(room);
  } else {
    await deleteRoom(room.id);
  }
}

// ---------------- 心跳清理 ----------------
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ---------------- 启动 ----------------
server.listen(PORT, () => {
  console.log(`对弈服务器已启动(内存版):`);
  console.log(`  网页客户端  http://localhost:${PORT}`);
  console.log(`  WebSocket   ws://localhost:${PORT}`);
  console.log(`  房间调试    http://localhost:${PORT}/api/rooms`);
});