export class LogCollector {
  private logBuffers: Map<string, string[]> = new Map();

  constructor() {
    this.seedDefaultLogs();
  }

  private seedDefaultLogs() {
    this.logBuffers.set('gateway-service', [
      `[${new Date(Date.now() - 60000).toISOString()}] INFO [gateway] Routing GET /api/v1/products -> products-service:3000 (status=200, 18ms)`,
      `[${new Date(Date.now() - 45000).toISOString()}] INFO [gateway] Routing POST /api/v1/orders -> orders-service:3001 (status=201, 45ms)`,
      `[${new Date(Date.now() - 30000).toISOString()}] INFO [gateway] Healthcheck OK - uptime 14280s`,
      `[${new Date(Date.now() - 15000).toISOString()}] INFO [gateway] Routing GET /api/v1/orders/1042 -> orders-service:3001 (status=200, 32ms)`
    ]);

    this.logBuffers.set('orders-service', [
      `[${new Date(Date.now() - 60000).toISOString()}] INFO [orders] DB Connection Pool healthy (8/10 active)`,
      `[${new Date(Date.now() - 40000).toISOString()}] INFO [orders] Order #1042 placed successfully. Total: $49.99`,
      `[${new Date(Date.now() - 20000).toISOString()}] INFO [orders] Health check 200 OK`
    ]);

    this.logBuffers.set('payments-service', [
      `[${new Date(Date.now() - 60000).toISOString()}] INFO [payments] Webhook processed for tx_88412`,
      `[${new Date(Date.now() - 40000).toISOString()}] INFO [payments] Charge captured: $49.99`,
      `[${new Date(Date.now() - 20000).toISOString()}] INFO [payments] Stripe webhook verified`
    ]);
  }

  public getRecentLogs(serviceId: string, limit: number = 30): string[] {
    const logs = this.logBuffers.get(serviceId) || [];
    return logs.slice(-limit);
  }

  public appendLog(serviceId: string, logLine: string): void {
    const logs = this.logBuffers.get(serviceId) || [];
    logs.push(`[${new Date().toISOString()}] ${logLine}`);
    if (logs.length > 200) {
      logs.shift();
    }
    this.logBuffers.set(serviceId, logs);
  }

  public injectFaultLogs(serviceId: string, scenario: 'bug_checkout' | 'slow_query' | 'killed_service' | 'bad_package' | 'memory_leak'): string {
    const timestamp = new Date().toISOString();
    let errorStackTrace = '';

    if (scenario === 'bug_checkout') {
      errorStackTrace = `TypeError: Cannot read properties of undefined (reading 'items')
    at OrderService.createOrder (/app/src/services/order.service.ts:42:27)
    at OrderController.checkout (/app/src/controllers/order.controller.ts:18:31)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:144:13)`;

      this.appendLog(serviceId, `ERROR [orders] Uncaught Exception in POST /api/v1/orders: ${errorStackTrace}`);
      this.appendLog(serviceId, `ERROR [orders] 500 Internal Server Error returned to client`);
    } else if (scenario === 'slow_query') {
      errorStackTrace = `KnexTimeoutError: Knex: Timeout acquiring a connection. The pool is probably full. Missing index on "orders.user_id" causing sequential table scan under load.
    at Client_PG.acquireConnection (/app/node_modules/knex/lib/client.js:334:26)
    at Runner.ensureConnection (/app/node_modules/knex/lib/execution/runner.js:283:28)
    at /app/src/services/order.service.ts:88:14`;

      this.appendLog(serviceId, `WARN [orders] DB Query duration exceeded threshold: 4280ms > 200ms`);
      this.appendLog(serviceId, `ERROR [orders] ${errorStackTrace}`);
    } else if (scenario === 'killed_service') {
      errorStackTrace = `ContainerExitError: container fake-shop-orders-1 exited with code 137 (SIGKILL / OOM Killed by kernel).
Docker daemon event: "die" container=fake-shop-orders-1 exitCode=137`;

      this.appendLog(serviceId, `FATAL [docker] ${errorStackTrace}`);
      this.appendLog(serviceId, `ERROR [gateway] Upstream connection refused: http://orders-service:3001/health`);
    } else if (scenario === 'memory_leak') {
      errorStackTrace = `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
1: 0xb09c30 node::Abort() [/usr/local/bin/node]
2: 0xa1b205 node::FatalError(char const*, char const*) [/usr/local/bin/node]
3: 0xcf75e2 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, bool) [/usr/local/bin/node]
4: 0xcf7957 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, bool) [/usr/local/bin/node]`;

      this.appendLog(serviceId, `WARN [orders] Heap used 492MB / 512MB limit (96.1%)`);
      this.appendLog(serviceId, `ERROR [orders] ${errorStackTrace}`);
    } else if (scenario === 'bad_package') {
      errorStackTrace = `[SIETCH SECURITY SHIELD] Malicious npm package execution detected in 'left-pad-lite@1.0.0':
- Attempted read: ~/.npmrc [INTERCEPTED]
- Attempted read: ~/.aws/credentials [INTERCEPTED]
- Socket connection: http://evil-exfil.invalid:80 [DENIED - Sandbox Network Disabled]`;

      this.appendLog(serviceId, errorStackTrace);
    }

    return errorStackTrace;
  }
}

export const logCollector = new LogCollector();
