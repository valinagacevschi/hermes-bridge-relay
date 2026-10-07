# Generated from expo-hermes; edit the private source, not this mirror.
# Builder uses node:20-alpine — Bun segfaults on no-AVX CPUs (CI runner and K8s nodes have no AVX).
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json ./
# npm install, not the Bun lockfile: Bun segfaults on these no-AVX runners.
# react-native-web and uniwind are pinned in package.json. 0.21.3 re-exports
# InputAccessoryView, and uniwind 1.12 redirects that to a web file it does
# not publish, so `expo export --platform web` fails.
RUN npm install --legacy-peer-deps

COPY . .

# CI=1 suppresses interactive prompts from Metro/Expo CLI
ENV CI=1
RUN npx expo export --platform web

# Compile server + migration TypeScript to plain CJS JS (no AVX required at runtime).
# Transpile-only (no --bundle): import specifiers survive verbatim, so these
# files may import node builtins and node_modules but NOT anything from lib/ --
# the runtime stage below copies no lib/, and Node ESM would need an explicit
# .mjs extension anyway.
RUN npx esbuild server/http.ts server/ws.ts db/migrate.ts --platform=node --format=esm --out-extension:.js=.mjs --outdir=.

# push.ts is bundled instead, because it imports lib/push-receipts.ts (the pure
# receipt-reconciliation logic, kept in lib/ so vitest can cover it -- see #65).
# --packages=external keeps node_modules resolved at runtime exactly as the
# transpile-only outputs do; only the local import is inlined. Bundling just
# this one entrypoint leaves the others' build shape untouched.
RUN npx esbuild server/push.ts --bundle --packages=external --platform=node --format=esm --outfile=server/push.mjs

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/http.mjs ./server/http.mjs
COPY --from=builder /app/server/ws.mjs ./server/ws.mjs
COPY --from=builder /app/server/push.mjs ./server/push.mjs
COPY --from=builder /app/db/migrate.mjs ./db/migrate.mjs
COPY --from=builder /app/db/schema.sql ./db/schema.sql
COPY --from=builder /app/package.json ./

# relay-http listens on PORT (default 3000)
# relay-ws listens on RELAY_WS_PORT (default 8082)
EXPOSE 3000 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/http.mjs"]
