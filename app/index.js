const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Read from env vars — injected by K8s ConfigMap
const APP_ENV = process.env.APP_ENV || 'development';
const VERSION = process.env.APP_VERSION || '1.0.0';
const POD_NAME = process.env.POD_NAME || 'unknown';  // injected by K8s downward API

app.get('/', (req, res) => {
  res.json({ status: 'ok', version: VERSION });
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

// Handle SIGTERM gracefully — critical for zero-downtime deploys
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${APP_ENV} mode`);
});

module.exports = server;
