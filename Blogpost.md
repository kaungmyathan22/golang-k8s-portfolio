# From Zero to Production: Building a Kubernetes CI/CD Pipeline from Scratch

*A hands-on walkthrough of deploying a Node.js API to Kubernetes with GitHub Actions, rolling deployments, and zero downtime — the way it's actually done in production.*

---

## What We're Building

Most Kubernetes tutorials stop at "here's how to run a pod." This one goes further.

By the end of this post you'll have a fully working system where every `git push` automatically builds, tests, scans, and deploys your app to Kubernetes — with zero downtime rolling updates, health checks, and runtime config injection.

Here's the full picture:

```
git push
    ↓
GitHub Actions (test → build → security scan)
    ↓
Docker image built with commit SHA as tag
    ↓
Kubernetes rolls out new version
    ↓
Zero downtime — old pods stay alive until new ones are healthy
```

**Stack:** Node.js · Docker · Kubernetes (minikube) · GitHub Actions · Trivy

---

## Project Structure

```
k8s-portfolio/
├── app/
│   ├── index.js
│   └── package.json
├── k8s/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── configmap.yaml
├── Dockerfile
└── .github/
    └── workflows/
        └── deploy.yml
```

Clean separation between app code, infrastructure config, and CI/CD — this is the pattern you'll see in every serious engineering team.

---

## The App

A simple 3-endpoint Express API. The app itself isn't the point — the infrastructure around it is. But it's designed to prove the infrastructure actually works.

```javascript
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// All config comes from environment variables
// Kubernetes injects these at runtime — no hardcoding
const APP_ENV = process.env.APP_ENV || 'development';
const VERSION = process.env.APP_VERSION || '1.0.0';
const POD_NAME = process.env.POD_NAME || 'unknown';

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
    pod: POD_NAME   // the pod injects its own name here at runtime
  });
});

// SIGTERM handler — critical for zero-downtime Kubernetes deployments
// When K8s wants to stop a pod, it sends SIGTERM first
// This gives the app time to finish in-flight requests before exiting
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${APP_ENV} mode`);
});
```

The `SIGTERM` handler is one of those details most tutorials skip. Without it, Kubernetes kills your pod mid-request and users see errors. With it, the app drains existing connections before exiting — that's what makes rolling deploys truly zero-downtime.

---

## The Dockerfile — Production Patterns

```dockerfile
# Stage 1 — install dependencies only
FROM node:20-alpine AS deps
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev

# Stage 2 — lean final image
FROM node:20-alpine AS runner
WORKDIR /app

# Never run containers as root in production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=deps /app/node_modules ./node_modules
COPY app/ .

EXPOSE 3000
CMD ["node", "index.js"]
```

Three production patterns in this single Dockerfile:

**Multi-stage build** — the `deps` stage installs npm and build tools. The `runner` stage gets only your code and `node_modules`. The final image has no build tooling, making it smaller and harder to exploit.

**`npm ci` instead of `npm install`** — `npm ci` requires a `package-lock.json` and installs exact versions. No silent upgrades, no "works on my machine" drift. Reproducible builds every time.

**Non-root user** — containers run as `appuser`, not root. If a vulnerability is exploited, the blast radius is limited to that user's permissions, not the entire host.

---

## Kubernetes Manifests

### ConfigMap — Externalising Config

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-api-config
data:
  APP_ENV: "production"
  APP_VERSION: "1.0.0"
```

Config lives outside the image. Change the version number, apply the ConfigMap, restart the deployment — no image rebuild required. This is the [12-factor app](https://12factor.net/config) principle applied to Kubernetes.

### Deployment — Where the Real Decisions Are

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0   # never kill an old pod before new one is ready
      maxSurge: 1         # allow 1 extra pod during the rollout
  template:
    metadata:
      labels:
        app: my-api
    spec:
      containers:
      - name: my-api
        image: my-api:local
        ports:
        - containerPort: 3000
        envFrom:
        - configMapRef:
            name: my-api-config       # inject all ConfigMap keys as env vars
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name  # Downward API — pod tells itself its own name
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "128Mi"
            cpu: "200m"
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 20
```

A few decisions worth calling out:

**`maxUnavailable: 0`** — this is the key to zero-downtime deployments. Kubernetes won't terminate an old pod until the new pod has passed its readiness probe. Combined with the readiness probe on `/health`, traffic never reaches a pod that isn't ready.

**Resource requests vs limits** — `requests` is what Kubernetes reserves for your pod on the node. `limits` is the maximum it can use before getting killed. Always set both. Without limits, a runaway process can starve every other pod on the node.

**The Downward API** — that `fieldRef: metadata.name` block is Kubernetes injecting the pod's own metadata as an environment variable. The app doesn't need to know it's running in Kubernetes — it just reads `process.env.POD_NAME` like any other env var. Hit `/info` on the running app and you'll see the actual pod name in the response.

**Health probes** — `readinessProbe` asks "is this pod ready to receive traffic?" `livenessProbe` asks "is this pod still alive?" They're different. A pod that fails readiness gets removed from the load balancer but stays running. A pod that fails liveness gets restarted entirely.

---

## The CI/CD Pipeline

```yaml
name: Build and Deploy

on:
  push:
    branches: [ main ]

env:
  IMAGE_NAME: my-api
  IMAGE_TAG: ${{ github.sha }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: app/package.json
    - run: cd app && npm ci
    - run: cd app && npm test

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
    - uses: actions/checkout@v4
    - name: Build Docker image
      run: |
        docker build -t $IMAGE_NAME:$IMAGE_TAG .
        docker tag $IMAGE_NAME:$IMAGE_TAG $IMAGE_NAME:latest

    - name: Run Trivy security scan
      uses: aquasecurity/trivy-action@master
      with:
        image-ref: ${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }}
        format: 'table'
        exit-code: '0'
        severity: 'CRITICAL,HIGH'
```

**Why `github.sha` as the image tag?**

Every commit gets a unique, immutable tag. You can always roll back to any previous version by its exact commit hash. Using `latest` means you can never tell what version is actually running in production. Seniors don't use `latest` in CI.

**Why Trivy in the pipeline?**

Every image gets scanned for known CVEs before it can be deployed. Catching a critical vulnerability in CI — before it reaches production — is free. Catching it after a breach is not. `exit-code: '0'` means it warns without failing the build for now. Bump it to `'1'` when you're ready to enforce it hard.

**`needs: test`** — the build job only runs if tests pass. Never build and push a broken image.

---

## Proving It Works

After deploying, port-forward the service and hit each endpoint:

```bash
kubectl port-forward service/my-api-service 8080:80 &

curl http://localhost:8080/
# {"status":"ok","version":"1.1.0"}

curl http://localhost:8080/health
# {"healthy":true,"uptime":62}

curl http://localhost:8080/info
# {"environment":"production","version":"1.1.0","pod":"my-api-9575f57fb-qb9xd"}
```

Each field in `/info` is injected by a different Kubernetes mechanism:

- `environment` — from the ConfigMap via `envFrom`
- `version` — also from ConfigMap
- `pod` — from the Downward API via `fieldRef`

The app itself has no Kubernetes-specific code. It just reads environment variables.

### Watching a Rolling Deployment

Make a code change, bump the version in the ConfigMap, and watch Kubernetes replace pods one by one:

```bash
kubectl rollout status deployment/my-api

# Waiting for deployment "my-api" to finish: 1 out of 2 new replicas have been updated...
# Waiting for deployment "my-api" to finish: 1 old replicas are pending termination...
# deployment "my-api" successfully rolled out
```

At no point during that output did traffic drop. The old pod stayed alive, serving requests, until the new pod passed its readiness probe. That's `maxUnavailable: 0` working exactly as designed.

And if something goes wrong with a deploy:

```bash
kubectl rollout undo deployment/my-api
# immediately rolls back to the previous version
```

---

## Key Takeaways

Everything in this post is standard production practice — not tutorial shortcuts:

- Multi-stage Dockerfiles reduce image size and attack surface
- `npm ci` with a lockfile gives reproducible builds
- Non-root containers limit blast radius of vulnerabilities
- `maxUnavailable: 0` + readiness probes = zero-downtime deployments
- ConfigMaps decouple config from images — change config without rebuilding
- The Downward API lets pods report their own identity without code changes
- `github.sha` image tags make every deployment traceable and rollbackable
- Trivy in CI catches CVEs before they reach production

The gap between "I deployed a pod" and "I deployed something production-worthy" comes down to these details. Most of them are small. All of them matter.

---

## What's Next

This project is the foundation. The natural next steps:

- **Observability** — add Prometheus metrics and a Grafana dashboard so you can actually see what's happening inside the cluster
- **GitOps with ArgoCD** — move from `kubectl apply` to Git-driven deployments where the cluster automatically syncs to your repo
- **Secrets management** — replace Kubernetes Secrets with HashiCorp Vault for proper encryption, audit logging, and dynamic credentials

The infrastructure is built. Now we make it observable.

---

*This post is part of a series documenting a hands-on DevOps learning journey. All code is available on [GitHub](https://github.com/kaungmyathan22/golang-k8s-portfolio).*