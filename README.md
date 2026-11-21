# AI SRE Agent Autonomous Backend (Problem Statement AIA-02)

Autonomous AI Site-Reliability Engineering (AI SRE) Backend with Real Monitoring, Gemini AI Diagnosis, Counterfactual Recovery Planning, Restricted Docker Remediation, Circuit-Breaker Cascading Prevention, and Sietch Supply-Chain Security.

---

## 🚀 Quick Start

```bash
# 1. Enter backend directory
cd backend

# 2. Configure environment (optional, defaults provided)
cp .env.example .env

# 3. Build and run tests (Runs all 5 test suites: 48 automated tests)
npm test

# 4. Start production server
npm start
# OR run in development mode
npm run dev
```

Server starts on **`http://localhost:5050`** (avoiding port collision with PulseShop Gateway on 4000) with real-time WebSocket on **`ws://localhost:5050/ws`**.

---

## 📡 REST API & WebSocket Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | Backend liveness check (`{ status: "UP", agent: "..." }`) |
| `/api/services` | `GET` / `POST` | List registered services / register new microservice |
| `/api/applications/connect` | `POST` | Hook any deployed web application into autonomous maintenance |
| `/api/incidents` | `GET` | List active and historical incidents with diagnosis & actions |
| `/api/incidents/:id` | `GET` | Detailed incident record with evidence and counterfactual plans |
| `/api/incidents/:id/approve` | `POST` | Operator approval for `ASK_FIRST` tier (`X-Operator-Token: sre-operator-secret-2026`) |
| `/api/scorecard` | `GET` | Autonomous metrics: MTTD, MTTR, time saved, Sietch threats blocked |
| `/api/postmortems` | `GET` | Automated root-cause postmortem write-ups |
| `/api/webhooks/deploy` | `POST` | Ingest CI/CD deployment markers & commit SHAs |
| `/api/webhooks/logs` | `POST` | Ingest microservice application exceptions & stack traces |
| `/api/sietch/check` | `POST` | Sietch supply-chain malicious package security verification |
| `/api/incidents/simulate` | `POST` | Fault injection & live demo scenarios |
| `/api/incidents/reset` | `POST` | Reset all services to healthy baseline |
| `/ws` | `WS` | Real-time event stream (`INCIDENT_DETECTED`, `INCIDENT_DIAGNOSED`, `INCIDENT_UPDATED`, etc.) |

---

## 🧪 Automated Test Suites

The backend includes 5 automated test suites:

```bash
npm test
```

1. **`monitoring.test.ts` (6 tests)**: Real HTTP scraping, dual `/health` and `/metrics` probes, timeout detection, no simulated fallback in real mode, incident deduplication.
2. **`aiDiagnosis.test.ts` (8 tests)**: Gemini structured output validation, prompt injection defense (`<UNTRUSTED_OPERATIONAL_DATA>`), safety tier clamping, deterministic heuristic fallback.
3. **`recovery.test.ts` (10 tests)**: Restricted `child_process.execFile` Docker restart, container allowlist, human operator token authorization, real recovery verification.
4. **`recoveryPlanning.test.ts` (10 tests)**: Counterfactual strategy evaluation, thundering herd penalty on blind restarts during retry storms, circuit-breaker and retry-control adapters, cascading verification.
5. **`integration.test.ts` (14 tests)**: End-to-end integration readiness across multi-format telemetry, silent order drops with 200 OK, full REST API, WebSocket stream, and configuration safety.
