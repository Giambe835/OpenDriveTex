import { DurableObject } from "cloudflare:workers";

export class YjsRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string") {
      try {
        const msg = JSON.parse(message);
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
      } catch {}
    }

    const peers = this.ctx.getWebSockets();
    for (const peer of peers) {
      if (peer !== ws) {
        try {
          peer.send(message);
        } catch {
          try { peer.close(); } catch {}
        }
      }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "Closed"); } catch {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, "Error"); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response(
        JSON.stringify({ status: "ok", service: "opendrivetex-durable-relay" }),
        { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    const roomName = url.searchParams.get("room") || "global-signaling-room";
    const id = env.YJS_ROOMS.idFromName(roomName);
    const stub = env.YJS_ROOMS.get(id);
    return stub.fetch(request);
  },
};
