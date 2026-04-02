const express = require('express');
const promClient = require('prom-client');
const app = express();
const PORT = process.env.PORT || 3000;

// Read from env vars — injected by K8s ConfigMap
const APP_ENV = process.env.APP_ENV || 'development';
const VERSION = process.env.APP_VERSION || '1.0.0';
const POD_NAME = process.env.POD_NAME || 'unknown';  // injected by K8s downward API


// ── Prometheus setup ──────────────────────────────────────
// Collect default Node.js metrics automatically
// (event loop lag, memory, CPU, active handles etc.)
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Custom metric 1 — count every HTTP request
// Labels let you slice by method, route, and status code
const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Custom metric 2 — measure how long requests take
// Histogram gives you percentiles (p50, p95, p99)
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

// Middleware — runs on every request, records metrics automatically
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.path,
      status_code: res.statusCode,
    };
    httpRequestCounter.inc(labels);
    end(labels);
  });
  next();
});
// ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', version: VERSION,message:"Hello from my CI/CD pipeline" });
});

app.get('/health', (req, res) => {
  res.json({ healthy: true, uptime: Math.floor(process.uptime()) });
});

app.get('/info', (req, res) => {
  res.json({
    environment: APP_ENV,
    version: VERSION,
    pod: POD_NAME       // proves K8s is injecting the pod name
  });
});

// Prometheus scrapes this endpoint every 15 seconds
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

let server;

if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} in ${APP_ENV} mode`);
  });

  // Handle SIGTERM gracefully — critical for zero-downside deploys
  process.on('SIGTERM', () => {
    console.log('SIGTERM received — shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

module.exports = { app, server };
