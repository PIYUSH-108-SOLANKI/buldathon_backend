import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Recommended integration default: 5050 (avoids conflict with PulseShop Gateway on 4000)
  PORT: parseInt(process.env.PORT || '5050', 10),
  PROMETHEUS_URL: process.env.PROMETHEUS_URL || 'http://localhost:9090',
  GRAFANA_URL: process.env.GRAFANA_URL || 'http://localhost:3000',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  AI_TIMEOUT_MS: parseInt(process.env.AI_TIMEOUT_MS || '7000', 10),
  
  // Explicit Demo / Simulation mode setting
  // If false (default), unreachable services or failed scrapes are treated as real failures without synthetic masking.
  DEMO_MODE: process.env.DEMO_MODE === 'true',

  // Monitoring Timeouts
  SCRAPE_TIMEOUT_MS: parseInt(process.env.SCRAPE_TIMEOUT_MS || '2000', 10),
  HEALTH_CHECK_TIMEOUT_MS: parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '2500', 10),

  // Configurable Monitored Service Endpoints (defaulted to PulseShop ports: Gateway:4000, Orders:4001, Payments:4002)
  MONITORED_SERVICES: process.env.MONITORED_SERVICES || '',
  DEFAULT_SERVICE_URLS: {
    gateway: process.env.GATEWAY_URL || 'http://127.0.0.1:4000',
    orders: process.env.ORDERS_URL || 'http://127.0.0.1:4001',
    payments: process.env.PAYMENTS_URL || 'http://127.0.0.1:4002'
  },

  // Webhooks Configuration
  WEBHOOKS: {
    GITHUB_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
    SLACK_URL: process.env.SLACK_WEBHOOK_URL || '',
    DISCORD_URL: process.env.DISCORD_WEBHOOK_URL || ''
  },

  // Incident detection thresholds (Watcher rules)
  THRESHOLDS: {
    ERROR_RATE_MAX: 0.05,        // 5% 5xx errors for > 1 min
    LATENCY_P95_MAX_MS: 400,     // 400ms absolute or 2x baseline
    LATENCY_SPIKE_RATIO: 2.0,    // 2x baseline
    THROUGHPUT_DROP_RATIO: 0.5,  // 50% drop in business transactions (e.g. orders)
    BUSINESS_THROUGHPUT_MIN_RPM: 50, // Floor threshold for silent order drop detection
    MEMORY_LEAK_SLOPE_PER_MIN: 4 // % increase per min over 3 intervals
  },

  // Remediation & Docker Execution configuration
  ENABLE_DOCKER_REMEDIATION: process.env.ENABLE_DOCKER_REMEDIATION !== 'false',
  DOCKER_ALLOWED_CONTAINERS: (
    process.env.DOCKER_ALLOWED_CONTAINERS || 
    'pulseshop-gateway,pulseshop-orders,pulseshop-payments,fake-shop-orders-1,fake-shop-gateway-1,fake-shop-payments-1,disposable-test-container'
  ).split(',').map(s => s.trim()).filter(Boolean),
  SERVICE_CONTAINER_MAP: {
    'gateway-service': process.env.GATEWAY_CONTAINER || 'pulseshop-gateway',
    'orders-service': process.env.ORDERS_CONTAINER || 'pulseshop-orders',
    'payments-service': process.env.PAYMENTS_CONTAINER || 'pulseshop-payments',
    'pulseshop-gateway': 'pulseshop-gateway',
    'pulseshop-orders': 'pulseshop-orders',
    'pulseshop-payments': 'pulseshop-payments',
    'test-service': 'disposable-test-container'
  } as Record<string, string>,
  OPERATOR_APPROVAL_TOKEN: process.env.OPERATOR_APPROVAL_TOKEN || 'hackathon-operator-secret',
  DOCKER_EXEC_TIMEOUT_MS: parseInt(process.env.DOCKER_EXEC_TIMEOUT_MS || '15000', 10),

  // Circuit Breaker & Cascading Failure Controls
  ENABLE_CIRCUIT_BREAKER: process.env.ENABLE_CIRCUIT_BREAKER !== 'false',
  ENABLE_RETRY_CONTROLS: process.env.ENABLE_RETRY_CONTROLS !== 'false',
  CIRCUIT_BREAKER_ENDPOINTS: {
    'gateway-service': process.env.GATEWAY_CIRCUIT_BREAKER_URL || '',
    'orders-service': process.env.ORDERS_CIRCUIT_BREAKER_URL || '',
    'payments-service': process.env.PAYMENTS_CIRCUIT_BREAKER_URL || ''
  } as Record<string, string>,
  RETRY_CONTROL_ENDPOINTS: {
    'gateway-service': process.env.GATEWAY_RETRY_URL || '',
    'orders-service': process.env.ORDERS_RETRY_URL || '',
    'payments-service': process.env.PAYMENTS_RETRY_URL || ''
  } as Record<string, string>,
  
  // Baselines & SLA
  MANUAL_DIAGNOSIS_BASELINE_SEC: 900, // 15 minutes manual baseline for scorecard
  VERIFICATION_WINDOW_SEC: 60,        // 1 minute recovery verification
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10) // Poll metrics every 5 seconds
};
