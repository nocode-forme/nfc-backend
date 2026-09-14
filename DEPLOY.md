# 部署到云服务器指南

包内容:`server.js` + `web/index.html` + `package.json`(依赖仅 `ws`)+ 文档。
服务器要求:任意 Linux/Windows 云主机,装有 Node.js ≥ 16,放行一个 TCP 端口(默认 8080)。

## 方式一:SSH 上传(推荐)

```bash
# 本机执行:上传压缩包
scp utep-game-deploy.tar.gz root@<服务器IP>:/opt/

# 登录服务器
ssh root@<服务器IP>

# 服务器上执行
cd /opt && tar -xzf utep-game-deploy.tar.gz && cd utep-game
npm install --production        # 只装 ws,秒级完成
node server.js                  # 前台试跑,默认 8080;PORT=80 改端口
```

试跑 OK 后用 systemd 常驻(重启不丢):

```bash
cat > /etc/systemd/system/utep-game.service <<'EOF'
[Unit]
Description=UTEP game server
After=network.target

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

## 云控制台还要做的一步(必做)

**安全组/防火墙放行端口**:在云厂商网页控制台找到「安全组」或「防火墙规则」,
添加入站规则:TCP、端口 8080(或你 PORT 指定的)、来源 0.0.0.0/0。
不放行的话,外网永远打不开。

## 验证

- 服务器本机:`curl http://localhost:8080/api/urls`
- 你的电脑浏览器:`http://<服务器公网IP>:8080` → 应看到对弈页面
- 把这个公网网址发给搭档,双方点「快速匹配」即可跨网络对战,不再需要热点/内网穿透

## 注意

- 本项目**没有 AI 服务端组件**——人机对战的 AI 在浏览器里跑,服务器只是调度+透传;
  如果你的"AI"指某个人工智能托管平台,请确认它能运行 Node.js 常驻进程并开放 WebSocket 端口,
  否则应部署到普通云主机(如上)
- `RESUME_TIMEOUT_MS` 环境变量可调断线保留时长(默认 30 分钟)
