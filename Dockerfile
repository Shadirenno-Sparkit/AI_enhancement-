# ─── Build ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so the dependency layer caches independently of source.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop-bridge/package.json packages/desktop-bridge/

# better-sqlite3 needs a toolchain when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm run build

# Drop dev dependencies from the layer that gets copied into the runtime image.
RUN npm prune --omit=dev

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# yt-dlp gives the cleanest caption path; ffmpeg enables frame sampling;
# tesseract is the cheap OCR fallback. All optional at runtime, but shipping
# them means the extraction waterfall works out of the box.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg tesseract-ocr python3-minimal curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production PORT=4000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/desktop-bridge ./packages/desktop-bridge

# Runs unprivileged; only the mounted data directory is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
