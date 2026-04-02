## k8s-portfolio — Project 1

A production-style Node.js API deployed on Kubernetes with full CI/CD.

### What's demonstrated
- Multi-stage Dockerfile with non-root user (security best practice)
- Kubernetes Deployment with rolling update strategy (zero downtime)
- ConfigMap injection — runtime config without rebuilding images
- Downward API — pod self-identifying at runtime
- Readiness + liveness probes — traffic only reaches healthy pods
- GitHub Actions pipeline — test → build → Trivy scan on every push
- SIGTERM handling — graceful shutdown during rolling deploys

### Stack
Node.js · Docker · Kubernetes · GitHub Actions · Trivy