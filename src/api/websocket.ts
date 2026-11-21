import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

class WebSocketBroadcaster {
  private wss?: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  public init(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      // Welcome handshake
      ws.send(JSON.stringify({
        type: 'CONNECTED',
        message: 'Connected to SRE Agent Real-Time Stream',
        timestamp: new Date().toISOString()
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  public broadcast(type: string, payload: any): void {
    const data = JSON.stringify({
      type,
      payload,
      timestamp: new Date().toISOString()
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  public close(): void {
    for (const client of this.clients) {
      try {
        client.terminate();
      } catch (e) {}
    }
    this.clients.clear();
    if (this.wss) {
      try {
        this.wss.close();
      } catch (e) {}
    }
  }
}

export const wsBroadcaster = new WebSocketBroadcaster();
