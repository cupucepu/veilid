// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — WebSocket shim for sandboxed egress.
//
// The Midnight wallet SDK and indexer provider open GraphQL-WS subscriptions
// through the *global* `WebSocket`. In this VM all egress goes through an
// HTTP proxy (HTTPS_PROXY), which Node's built-in WebSocket and the `ws`
// package do not use on their own — direct wss connections fail at the TLS
// handshake ("wrong version number"). This shim replaces the global WebSocket
// with a `ws`-based one that tunnels through the proxy via CONNECT, so the
// SDK's subscriptions work unchanged.
//
// Only installed when a proxy is configured; otherwise the native WebSocket
// is left alone. The proxy URL (which carries egress credentials) is never
// logged. Import this module FIRST in main.ts, before any SDK code runs.
import WebSocket from "ws";
import proxyAgentPkg from "https-proxy-agent";

const { HttpsProxyAgent } = proxyAgentPkg;

const proxyUrl =
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy ??
  "";

if (proxyUrl !== "") {
  const agent = new HttpsProxyAgent(proxyUrl);
  class ProxiedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      // HttpsProxyAgent (agent-base) is runtime-compatible with ws's Agent
      // option but not assignable in its types; cast at the boundary.
      super(url, protocols, { agent: agent as unknown as import("http").Agent });
    }
  }
  (globalThis as unknown as { WebSocket: typeof ProxiedWebSocket }).WebSocket =
    ProxiedWebSocket;
}
