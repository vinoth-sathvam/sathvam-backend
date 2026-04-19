# ─── Stage 1: deps ───────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Skip Puppeteer's bundled Chromium (~300MB) — use system chromium at runtime
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Install Chromium system package (for Puppeteer PDF generation)
RUN apk add --no-cache chromium

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Non-root user for security
RUN addgroup -S sathvam && adduser -S sathvam -G sathvam

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove dev/sensitive files from image
RUN rm -f .env .env.* *.keystore *.jks

USER sathvam
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "server.js"]
