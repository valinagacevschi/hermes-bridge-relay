<!-- Generated from expo-hermes; edit the private source, not this mirror. -->
# Hermes Bridge Relay

Standalone HTTP, WebSocket, and push-worker distribution for Hermes Bridge.
This repository is generated from an explicit allowlist in the private
`expo-hermes` source repository. Review changes through sync pull requests;
edit the private source, not generated files here.

## What is included

The distribution contains the Expo Router API handlers, a Node HTTP adapter
that streams SSE directly, a separate WebSocket process, a singleton push
worker, PostgreSQL schema/migration, focused relay tests, and Kubernetes
examples. The mobile app, screens, private planning documents, and unrelated
Expo modules are not part of this repository.

HTTP listens on `3000` and WebSocket on `8082`. The ingress must route `/ws/`
to the WebSocket port and `/` to HTTP, allow WebSocket upgrades, and disable
proxy buffering for `/api/relay/stream/`; the HTTP adapter streams that SSE
route directly because Expo's adapter buffers complete response bodies. Run
exactly one push worker so Redis notifications are not delivered more than
once. The Kubernetes deployment template encodes these process boundaries.

## Run locally

Requirements: Node.js 20, PostgreSQL, Redis.

```sh
npm install --legacy-peer-deps
npm run build:runtime
npm run db:migrate
npm run start:http
npm run start:ws    # separate terminal
npm run start:push  # separate terminal; one worker only
```

Set `DATABASE_URL` and `REDIS_URL` for all processes. Set `PUBLIC_URL` to the
public relay URL for admin invite links; set `ADMIN_SECRET` to enable
`POST /api/admin/invites`. `PORT` (HTTP, default `3000`) and `RELAY_WS_PORT`
(WebSocket, default `8082`) are optional. Pair phones with
`POST /api/pair/provision` or create an admin invite with
`POST /api/admin/invites`. `GET /api/health` checks PostgreSQL and
`GET /api/live` is process liveness.

## Build and checks

```sh
npm test
npm run typecheck
npm run build
npm run build:runtime
docker build -t hermes-bridge-relay .
```

The image runs HTTP by default. Run `server/ws.mjs` and `server/push.mjs` as
separate commands/deployments. `kubernetes/` contains deployable examples;
provide your own database, Redis, ingress host, TLS issuer, image pull secret,
and Kubernetes Secrets. `secret.yaml` and real cluster credentials are
intentionally absent.

The deployment init container runs the idempotent schema on each rollout.
Review `db/schema.sql` and take a database backup before production migration;
the schema includes a one-time teardown of legacy team tables and columns.

## License

No license has been granted for this public mirror. All rights are reserved
unless the repository owner adds an explicit license. Do not assume public
visibility grants permission to reuse or redistribute this code.
