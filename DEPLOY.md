# 部署到云服务器指南

包内容:`server.js` + `web/`(`landing.html` / `index.html` / `calibration.html`)+
`package.json`(依赖 `ws` + `redis`)+ 文档。
服务器要求:任意 Linux/Windows 云主机,装有 Node.js ≥ 16 与 Redis,放行一个 TCP 端口(默认 8080)。

## 方式一:SSH 上传(推荐)

```bash
# 本机执行:上传压缩包
scp utep-game-deploy.tar.gz root@<服务器IP>:/opt/

# 登录服务器
ssh root@<服务器IP>

# 服务器上执行
cd /opt && tar -xzf utep-game-deploy.tar.gz && cd utep-game
npm install --production        # 装 ws + redis 客户端
```

**先启动 Redis,再启动服务器**——房间元数据存在 Redis 里,服务器启动时会连接
Redis,连不上会直接崩溃退出:

```bash
# Ubuntu/Debian
sudo apt install -y redis-server
sudo systemctl enable --now redis-server

# CentOS / Alibaba Cloud Linux
sudo yum install -y redis
sudo systemctl enable --now redis

# 两种发行版通用:确认 Redis 真的活着
redis-cli ping     # 应返回 PONG
```

确认 Redis 正常后再启动游戏服务器:

```bash
node server.js                  # 前台试跑,默认 8080;PORT=80 改端口
```

试跑 OK 后用 systemd 常驻(重启不丢):

```bash
cat > /etc/systemd/system/utep-game.service <<'EOF'
[Unit]
Description=UTEP game server
After=network.target redis-server.service

[Service]
WorkingDirectory=/opt/utep-game
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now utep-game
systemctl status utep-game      # 看运行状态
```

`After=redis-server.service` 让 systemd 优先启动 Redis,避免游戏服务器在
Redis 就绪之前就抢先启动而崩溃(如果你的发行版把 Redis 服务叫 `redis`
而非 `redis-server`,把这一行的服务名改成对应的)。

## 云控制台还要做的一步(必做)

**安全组/防火墙放行端口**:在云厂商网页控制台找到「安全组」或「防火墙规则」,
添加入站规则:TCP、端口 8080(或你 PORT 指定的)、来源 0.0.0.0/0。
不放行的话,外网永远打不开。

**Redis 端口(6379)不要对外开放**——它应当只监听 `127.0.0.1`,只被同一台机器
上的 Node 进程访问。确认 `/etc/redis/redis.conf`(或 `/etc/redis.conf`)里
`bind 127.0.0.1` 这一行没被注释掉、且安全组里没有对 6379 开放公网入站——
一个无密码、暴露在公网的 Redis 是常见的服务器被入侵/挖矿的攻击入口。

## 验证

- 服务器本机:`redis-cli ping` → 应返回 `PONG`
- 服务器本机:`curl http://localhost:8080/api/rooms` → 应返回 `[]`(尚无房间时)
- 你的电脑浏览器:`http://<服务器公网IP>:8080` → 应看到落地页(选择「双方对战」或「AI 对战」)
- 把这个公网网址发给搭档,双方点「快速匹配」即可跨网络对战,不再需要热点/内网穿透

## 页面路由一览

| 路径 | 内容 |
|---|---|
| `/` 或 `/landing.html` | 落地页(语言切换 + 模式选择) |
| `/index.html` 或 `/demo` | 五子棋对弈客户端(真人对战 / 人机对局) |
| `/calibration.html` | 硬件校准演示页(支持 `?mode=pvp` / `?mode=ai` 查询参数) |
| `/api/rooms` | 调试接口:列出当前所有房间状态 |

## 注意

- 本项目**没有 AI 服务端组件**——人机对战的 AI 在浏览器里跑,服务器只是调度+透传;
  如果你的"AI"指某个人工智能托管平台,请确认它能运行 Node.js 常驻进程、开放
  WebSocket 端口、且能额外跑一个 Redis 实例,否则应部署到普通云主机(如上)
- `RESUME_TIMEOUT_MS` 环境变量可调断线保留时长(默认 30 分钟)
- `REDIS_URL` 环境变量可指向非本机的 Redis(默认 `redis://127.0.0.1:6379`),
  例如使用云厂商的托管 Redis 服务时:
  ```bash
  REDIS_URL=redis://your-redis-host:6379 node server.js
  ```
