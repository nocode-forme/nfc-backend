/**
 * 对弈原型服务器
 * 职责:回合制调度 + 数据透传 + 局内元数据维护
 * 非职责:AI 决策、胜负判定、渲染、业务数据格式定义(全部由客户端自理)
 *
 * 通信:WebSocket + JSON,消息统一形如 { "type": "...", ...字段 }
 * 完整接口说明见 API.md
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
// 断线后房间保留多久(毫秒):期间重新入座可继续没下完的局,超时则释放房间
const RESUME_TIMEOUT_MS = Number(process.env.RESUME_TIMEOUT_MS || 30 * 60 * 1000);

// ---------------- 房间模型 ----------------
// rooms: Map<roomId, room>
// room = {
//   id, seats: { A: ws|null, B: ws|null },
//   turn: 'A'|'B'|null,      当前行动权
//   turnCount: number,        已落下步数(每 move +1)
//   history: [{seat,payload,turnCount}],  透传 payload 原样保存
//   state: 'waiting'|'playing'|'over',
//   rematch: { A: bool, B: bool },  终局后双方是否已请求再来一局
//   firstMover: 'A'|'B',            下一局先手方(每开一局自动轮换,先后手交替)
//   createdAt
// }
const rooms = new Map();

function newRoomId() {
  // 6 位大写十六进制房间号,便于口头/文字转告对方
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function joinSeat(room, ws, seat) {
  if (room._resumeTimer) {
    clearTimeout(room._resumeTimer);
    room._resumeTimer = null;
  }
  room.seats[seat] = ws;
  ws._room = room;
  ws._seat = seat;
}

// 有人离座后启动保留计时:超时仍缺人才真正释放房间
function armExpiry(room) {
  if (room._resumeTimer) clearTimeout(room._resumeTimer);
  room._resumeTimer = setTimeout(() => {
    if (rooms.get(room.id) === room && (!room.seats.A || !room.seats.B)) {
      const rest = room.seats.A || room.seats.B;
      if (rest) send(rest, 'room_expired', { roomId: room.id });
      rooms.delete(room.id);
      console.log(`[room ${room.id}] expired (seat empty over ${RESUME_TIMEOUT_MS}ms)`);
    }
  }, RESUME_TIMEOUT_MS);
}

function leaveSeat(ws) {
  const room = ws._room;
  if (!room) return;
  if (room.seats[ws._seat] === ws) room.seats[ws._seat] = null;
  ws._room = null;
  ws._seat = null;
}

const opponentSeat = (seat) => (seat === 'A' ? 'B' : 'A');

// ---------------- 消息工具 ----------------
function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcast(room, type, data = {}) {
  for (const seat of ['A', 'B']) send(room.seats[seat], type, data);
}

function snapshot(room) {
  // 局内元数据快照(用于断线重连 / sync)
  return {
    roomId: room.id,
    state: room.state,
    turn: room.turn,
    turnCount: room.turnCount,
    history: room.history,
    rematch: room.rematch,
    seats: {
      A: room.seats.A ? true : false,
      B: room.seats.B ? true : false,
    },
  };
}

// ---------------- HTTP:托管网页客户端 ----------------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'web', 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end('client file missing');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  // 轻量 HTTP 接口:房间是否存在 / 房间列表(调试用)
  if (req.url === '/api/rooms') {
    const list = [...rooms.values()].map((r) => ({
      roomId: r.id,
      state: r.state,
      players: (r.seats.A ? 1 : 0) + (r.seats.B ? 1 : 0),
      turn: r.turn,
      turnCount: r.turnCount,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  // 可分享的访问地址(本机 + 局域网 IP),供网页客户端展示"发给对方的网址"
  if (req.url === '/api/urls') {
    const lan = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
      }
    }
    // 虚拟网卡(VMware/VirtualBox)的地址几乎都以 .1 结尾且外部不可达,排到最后
    const real = lan.filter((ip) => !ip.endsWith('.1'));
    const urls = [`http://localhost:${PORT}`, ...(real.length ? real : lan).map((ip) => `http://${ip}:${PORT}`)];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ urls }));
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
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
      handle(ws, msg);
    } catch (err) {
      console.error('handle error:', err);
      send(ws, 'error', { code: 'INTERNAL', message: String(err.message || err) });
    }
  });

  ws.on('close', () => {
    const qi = waitingQueue.indexOf(ws);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    const room = ws._room;
    leaveSeat(ws);
    if (!room) return;
    const other = room.seats.A || room.seats.B;
    if (other) {
      send(other, 'opponent_left', { roomId: room.id });
      // 对局挂起而非销毁,等待原座位重连(join_room 支持抢占空座位)
      if (room.state === 'playing') room.state = 'waiting';
      room.rematch = { A: false, B: false }; // 有人走就清掉再来一局的请求,避免残留
      armExpiry(room); // 限时保留,超时释放
    } else {
      rooms.delete(room.id); // 人都走光,回收房间
    }
  });
});

// ----快速匹配:免去房间号传递,先等待者坐 A,后来者坐 B,即刻开局
const waitingQueue = [];

function handleQuickMatch(ws) {
  if (ws._room) {
    return send(ws, 'error', { code: 'ALREADY_IN_ROOM', message: '已在房间中,请先 leave' });
  }
  if (waitingQueue.includes(ws)) {
    return send(ws, 'match_waiting', {}); // 重复点击保持等待,幂等
  }
  // 取出最早仍在等待的玩家
  let partner = null;
  while (waitingQueue.length) {
    const cand = waitingQueue.shift();
    if (cand.readyState === cand.OPEN && !cand._room) {
      partner = cand;
      break;
    }
  }
  if (!partner) {
    waitingQueue.push(ws);
    return send(ws, 'match_waiting', {});
  }
  const room = { id: newRoomId(), seats: { A: null, B: null }, turn: null, turnCount: 0, history: [], state: 'waiting', rematch: { A: false, B: false }, firstMover: Math.random() < 0.5 ? 'A' : 'B', createdAt: Date.now() };
  rooms.set(room.id, room);
  joinSeat(room, partner, 'A');
  joinSeat(room, ws, 'B');
  send(partner, 'match_found', { roomId: room.id, yourSeat: 'A' });
  send(ws, 'match_found', { roomId: room.id, yourSeat: 'B' });
  startNewGame(room); // 首局先手随机,此后每局轮换
  console.log(`[room ${room.id}] quick match: A+B paired`);
}

function handleCancelMatch(ws) {
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
  send(ws, 'match_cancelled', {});
}

function handle(ws, msg) {
  switch (msg.type) {
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

// ----建房:自动落座 A,等待对手
function handleCreate(ws) {
  if (ws._room) {
    return send(ws, 'error', { code: 'ALREADY_IN_ROOM', message: '已在房间中,请先 leave' });
  }
  const room = { id: newRoomId(), seats: { A: null, B: null }, turn: null, turnCount: 0, history: [], state: 'waiting', rematch: { A: false, B: false }, firstMover: 'A', createdAt: Date.now() };
  rooms.set(room.id, room);
  joinSeat(room, ws, 'A');
  send(ws, 'room_created', { roomId: room.id, yourSeat: 'A' });
  console.log(`[room ${room.id}] created by seat A`);
}

// ----加入:抢占空座位;A 先手,双方到齐即开局
function handleJoin(ws, msg) {
  if (ws._room) {
    return send(ws, 'error', { code: 'ALREADY_IN_ROOM', message: '已在房间中,请先 leave' });
  }
  const room = rooms.get(String(msg.roomId || '').toUpperCase());
  if (!room) return send(ws, 'error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' });

  // 断线重连优先坐回原座位(避免与对手换边)
  const prefer = msg.preferSeat === 'A' || msg.preferSeat === 'B' ? msg.preferSeat : null;
  const freeSeat = prefer && !room.seats[prefer] ? prefer : room.seats.A ? (room.seats.B ? null : 'B') : 'A';
  if (!freeSeat) return send(ws, 'error', { code: 'ROOM_FULL', message: '房间已满' });

  joinSeat(room, ws, freeSeat);
  send(ws, 'room_joined', { roomId: room.id, yourSeat: freeSeat });

  const both = room.seats.A && room.seats.B;
  if (both && room.state !== 'over') {
    room.rematch = { A: false, B: false };
    if (room.turnCount > 0) {
      // 中断过的对局:保留棋盘、历史与行棋权,双方恢复继续下
      room.state = 'playing';
      broadcast(room, 'game_resumed', { roomId: room.id, turn: room.turn, turnCount: room.turnCount, history: room.history });
      console.log(`[room ${room.id}] game resumed at move ${room.turnCount}, turn=${room.turn}`);
    } else {
      // 一手未下:正常重开(先手按房间轮换记录)
      startNewGame(room);
    }
  } else {
    send(ws, 'sync_state', { room: snapshot(room) });
  }
}

// ----开新局:按房间记录的先手方开局,并轮换(这把 A 先则下把 B 先,先后手交替)
function startNewGame(room) {
  room.turn = room.firstMover;
  room.turnCount = 0;
  room.history = [];
  room.rematch = { A: false, B: false };
  room.state = 'playing';
  broadcast(room, 'game_start', { roomId: room.id, firstTurn: room.firstMover });
  console.log(`[room ${room.id}] game start, first mover = ${room.firstMover}`);
  room.firstMover = opponentSeat(room.firstMover); // 下一局换先
}

// ----落子:唯一由服务端强校验的通道,保证回合不错乱
function handleMove(ws, msg) {
  const room = ws._room;
  if (!room) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  if (room.state !== 'playing') {
    return send(ws, 'error', { code: 'NOT_PLAYING', message: `当前房间状态为 ${room.state},不能落子` });
  }
  if (room.turn !== ws._seat) {
    return send(ws, 'error', { code: 'NOT_YOUR_TURN', message: `当前行动方是 ${room.turn}` });
  }
  if (msg.payload === undefined) {
    return send(ws, 'error', { code: 'NO_PAYLOAD', message: 'move 需要 payload 字段' });
  }

  const record = { seat: ws._seat, payload: msg.payload, turnCount: room.turnCount + 1 };
  room.history.push(record);
  room.turnCount += 1;
  room.turn = opponentSeat(room.turn);
  broadcast(room, 'move_made', {
    roomId: room.id,
    seat: record.seat,
    payload: record.payload, // 原样透传,服务端不理解内容
    turnCount: record.turnCount,
    nextTurn: room.turn,
  });
}

// ----透传:任意业务数据原样转发给对方,服务端零解析
function handleRelay(ws, msg) {
  const room = ws._room;
  if (!room) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  const to = room.seats[opponentSeat(ws._seat)];
  if (!to) return send(ws, 'error', { code: 'OPPONENT_OFFLINE', message: '对方不在线' });
  send(to, 'relay', { roomId: room.id, from: ws._seat, payload: msg.payload });
}

// ----终局:由客户端判定胜负后上报,服务端只记账并广播
function handleGameOver(ws, msg) {
  const room = ws._room;
  if (!room) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  if (room.state === 'over') return; // 双方客户端可能都判胜并各上报一次,去重只广播一次
  room.state = 'over';
  room.rematch = { A: false, B: false };
  broadcast(room, 'game_over', {
    roomId: room.id,
    winner: msg.winner ?? null,
    reason: msg.reason ?? 'client_declared',
    payload: msg.payload, // 终局附加数据原样透传
  });
  console.log(`[room ${room.id}] game over, winner=${msg.winner ?? '-'}`);
}

// ----再来一局:终局后任意一方请求,双方都请求则原地重开(同房间同对手)
function handleRematch(ws) {
  const room = ws._room;
  if (!room) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  if (room.state !== 'over') {
    return send(ws, 'error', { code: 'NOT_OVER', message: '对局尚未结束,不能请求再来一局' });
  }
  room.rematch[ws._seat] = true;
  broadcast(room, 'rematch_state', { roomId: room.id, requested: ['A', 'B'].filter((s) => room.rematch[s]) });
  if (room.rematch.A && room.rematch.B) {
    startNewGame(room);
    console.log(`[room ${room.id}] rematch accepted, game restarts`);
  }
}

// ----状态同步:断线重连后拉取快照
function handleSync(ws) {
  const room = ws._room;
  if (!room) return send(ws, 'error', { code: 'NOT_IN_ROOM', message: '尚未加入房间' });
  send(ws, 'sync_state', { room: snapshot(room) });
}

// ----主动离席
function handleLeave(ws) {
  const room = ws._room;
  if (!room) return;
  leaveSeat(ws);
  room.rematch = { A: false, B: false };
  send(ws, 'left', { roomId: room.id });
  const other = room.seats.A || room.seats.B;
  if (other) {
    send(other, 'opponent_left', { roomId: room.id });
    armExpiry(room); // 主动离席同样限时保留,给反悔/误触留余地
  }
  else rooms.delete(room.id);
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

server.listen(PORT, () => {
  console.log(`对弈服务器已启动:`);
  console.log(`  网页客户端  http://localhost:${PORT}`);
  console.log(`  WebSocket   ws://localhost:${PORT}`);
  console.log(`  房间调试    http://localhost:${PORT}/api/rooms`);
});
