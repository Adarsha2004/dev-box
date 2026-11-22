import { WebSocketServer, WebSocket } from "ws";

const rooms = new Map<string, Set<WebSocket>>();

export function startWs(port: number): void {
  const wss = new WebSocketServer({ port, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      ws.close(4400, "sessionId required");
      return;
    }
    const set = rooms.get(sessionId) ?? new Set();
    rooms.set(sessionId, set);
    set.add(ws);
    ws.send(JSON.stringify({ type: "connected", sessionId }));
    ws.on("close", () => {
      set.delete(ws);
      if (!set.size) rooms.delete(sessionId);
    });
  });
  console.log(`ws server on ws://localhost:${port}/ws`);
}

export function publish(sessionId: string | number, event: Record<string, unknown>): void {
  const set = rooms.get(String(sessionId));
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
