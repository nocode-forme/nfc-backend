/**
 * GameClient —— 通用「客户端↔服务器」网络层
 * 职责:WebSocket 连接/断线自动重连、会话持久化(用于断线续弈)、
 *       消息收发的薄封装。
 * 非职责:不解读任何业务消息的含义 —— 房间/座位/回合/棋盘/AI/渲染等
 *       全部由使用方通过回调(onOpen/onMessage/...)自行处理。
 *       这一点和 server.js 的定位是对称的:server.js 只做「回合制调度 +
 *       数据透传」,不懂棋;GameClient 只做「连接 + 收发」,也不懂棋。
 *
 * 用法:
 *   const client = new GameClient({
 *     sessionKey: 'my_game_session',       // localStorage key,用于断线续弈
 *     getUrl: () => $('serverUrl').value,  // 可选:重连时用于取最新地址
 *   });
 *   client.onOpen = (session) => { ... };
 *   client.onMessage = (msg) => { ... };   // msg 已 JSON.parse
 *   client.connect(url);
 *   client.send('move', { payload: { x, y } });
 */
class GameClient {
  constructor(opts = {}) {
    this.sessionKey = opts.sessionKey || 'game_client_session';
    this.maxReconnectTries = opts.maxReconnectTries ?? 10;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3000;
    this.getUrl = opts.getUrl || null; // 重连时优先用这个取最新地址,而不是缓存的旧地址

    this.ws = null;
    this.url = null;
    this.reconnectTries = 0;
    this._reconnectTimer = null;

    // 使用方注入的回调,全部可选
    this.onOpen = null;          // (session|null) => void
    this.onClose = null;         // () => void
    this.onWsError = null;       // (evt) => void  底层 socket 错误
    this.onConnectError = null;  // (err) => void  地址非法等,new WebSocket 直接抛出
    this.onMessage = null;       // (msg) => void  收到并成功解析的一条服务器消息
    this.onReconnecting = null;  // (attempt, max) => void
    this.onGiveUp = null;        // () => void  重连次数耗尽,不再自动重试
  }

  get connected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  // 同源页面直接用当前 host,file:// 打开则回退本机——纯连接相关的推断逻辑
  static autoUrl() {
    if (location.protocol.startsWith('http')) {
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    }
    return 'ws://localhost:8080';
  }

  connect(url) {
    this.url = url;
    this._clearReconnectTimer();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onConnectError && this.onConnectError(err);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectTries = 0;
      this.onOpen && this.onOpen(this.loadSession());
    };

    ws.onclose = () => {
      this.onClose && this.onClose();
      const session = this.loadSession();
      if (session && this.reconnectTries < this.maxReconnectTries) {
        this.reconnectTries++;
        this.onReconnecting && this.onReconnecting(this.reconnectTries, this.maxReconnectTries);
        const nextUrl = this.getUrl ? this.getUrl() : this.url;
        this._reconnectTimer = setTimeout(() => this.connect(nextUrl), this.reconnectDelayMs);
      } else {
        this.onGiveUp && this.onGiveUp();
      }
    };

    ws.onerror = (evt) => this.onWsError && this.onWsError(evt);

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return; // 非法 JSON 静默丢弃,服务器端本来也会拒绝我们发的非法 JSON
      }
      this.onMessage && this.onMessage(msg);
    };
  }

  // 手动重连(例如用户点了「重连」按钮):立即关闭旧连接、重置计数、重新连接
  reconnectNow(url) {
    this._clearReconnectTimer();
    this.reconnectTries = 0;
    if (this.ws) this.ws.close();
    const nextUrl = url || (this.getUrl ? this.getUrl() : this.url);
    setTimeout(() => this.connect(nextUrl), 200);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  send(type, extra = {}) {
    if (this.connected) this.ws.send(JSON.stringify({ type, ...extra }));
  }

  /* ---------------- 会话持久化(断线续弈用) ----------------
   * 存的内容完全由调用方决定(比如 {roomId, seat}),GameClient 只管存取,
   * 不关心里面装的是什么业务字段。
   */
  saveSession(data) {
    localStorage.setItem(this.sessionKey, JSON.stringify({ ...data, t: Date.now() }));
  }
  loadSession() {
    try {
      return JSON.parse(localStorage.getItem(this.sessionKey));
    } catch {
      return null;
    }
  }
  clearSession() {
    localStorage.removeItem(this.sessionKey);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GameClient };
}
