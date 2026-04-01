# Stage 1 — install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --only=production

# Stage 2 — final image
FROM node:20-alpine AS runner
WORKDIR /app

# Security: never run as root in production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=deps /app/node_modules ./node_modules
COPY app/ .

EXPOSE 3000
CMD ["node", "index.js"]
