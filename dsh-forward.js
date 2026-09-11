#!/usr/bin/env node
/**
 * DshDocker 极简 TCP 转发器。
 *
 * 背景：DSH 的 web server 只允许绑定 127.0.0.1
 *   - dsh-web-app/startup.js 明确拒绝 --host 0.0.0.0
 *   - dsh-host-webserver 的 schema 只接受 "127.0.0.1" | "0.0.0.0"
 * 所以容器内的 dsh 只能听 loopback，而 docker -p 的 DNAT 是转发到容器 eth0，
 * 因此需要一个在 0.0.0.0 上监听、转发到 127.0.0.1 的转发器。
 *
 * 纯 TCP 转发，不改写任何 HTTP 头（Host / Origin 原样透传），
 * 这样 DSH 的 Host/Origin 信任围栏与 cookie 绑定才能按原始 authority 工作。
 */
import net from "node:net";

const listenPort = Number(process.env.DSH_FORWARD_LISTEN_PORT ?? 3080);
const targetHost = process.env.DSH_FORWARD_TARGET_HOST ?? "127.0.0.1";
const targetPort = Number(process.env.DSH_FORWARD_TARGET_PORT ?? 30801);

if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error("[dsh-forward] invalid port configuration");
  process.exit(1);
}

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", teardown);
  upstream.on("error", teardown);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (error) => {
  console.error(`[dsh-forward] ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, "0.0.0.0", () => {
  console.error(`[dsh-forward] listening 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}`);
});
