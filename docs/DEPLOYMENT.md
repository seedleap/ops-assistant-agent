# Production deployment

The production shape borrows the useful container boundaries from Carmack while
remaining intentionally smaller. This service runs remote models and calls a
remote Loopit data MCP service; it does not need Carmack's template prewarming, sandbox
containers, S3 sync tools, ffmpeg or autoscaling stack.

## Non-negotiable runtime boundary

`JsonStore` and the local scheduler are single-process MVP components. Run
exactly one application replica. The Kubernetes Deployment therefore uses
`replicas: 1`, `strategy: Recreate` and a `ReadWriteOnce` volume. Do not add an
HPA, canary replica or rolling overlap until state and scheduling move to durable
shared services.

## Build

Build one immutable image for the target production architecture:

```bash
docker buildx build \
  --platform linux/amd64 \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  -t "$REGISTRY/ops-assistant-agent:$(git rev-parse HEAD)" \
  --push .
```

The Dockerfile pins Node 22.19.0 and pnpm 10.13.1, uses a shared BuildKit pnpm
cache, installs production dependencies in a separate stage and runs as the
unprivileged `node` user under `tini`.

## Runtime data

The image stores versioned defaults under `/app/seed`. At startup the entrypoint
copies only missing config and knowledge files into `/app/data`; operator edits
on the persistent volume always win across restarts.

Persistent paths include:

- `/app/data/state.json`;
- Pi sessions and workspaces;
- `/app/data/config/agent-profiles` for per-Profile system prompts;
- `/app/data/config` for segments and scheduled-task config;
- `/app/data/skills` for managed knowledge;
- runtime auth/cache files.

## Secrets

Never bake `.env`, Google credentials, MCP service tokens or Langfuse keys into
the image. The required service secret should provide at least:

```text
API_JWT_SECRET
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
GOOGLE_CLOUD_PROJECT
OPS_MCP_URL
OPS_MCP_TOKEN
```

Mount the Google service-account JSON separately at
`/var/run/secrets/google/key.json`. Prefer workload identity when the target
cluster supports it; in that case remove the JSON secret volume and the
`GOOGLE_APPLICATION_CREDENTIALS` environment variable.

The service is intended to sit behind an authenticated internal gateway. The
built-in static debug UI is disabled in production. The gateway calls the API
with a backend-issued JWT and must preserve the client IP chain expected by
`TRUST_PROXY_HOPS`.

## Single-host Docker Compose

Inject the real `.env.production` through the secret manager, use an immutable image reference, and keep the service
bound to loopback behind a TLS reverse proxy:

```bash
export OPS_AGENT_IMAGE="$REGISTRY/ops-assistant-agent@sha256:<digest>"
export OPS_AGENT_ENV_FILE=/secure/path/ops-assistant-agent.env
export GOOGLE_APPLICATION_CREDENTIALS_FILE=/secure/path/google-key.json
docker compose -f compose.production.yaml up -d
```

The Compose definition uses a read-only root filesystem, drops Linux
capabilities, mounts only `/app/data` and `/tmp` writable, and allows two minutes
for Agent requests and Langfuse export to drain.

## Kubernetes

The Kustomize base lives in `deploy/k8s/base`; the production overlay is in
`deploy/k8s/production`.

Before deployment:

1. Replace the image registry/tag in `deploy/k8s/production/kustomization.yaml`
   with an immutable SHA or digest.
2. Replace the placeholder CORS origin in `configmap-patch.yaml`.
3. Set the PVC storage class if the cluster has no default class.
4. Create the namespace and external secrets:

```bash
kubectl apply -f deploy/k8s/production/namespace.yaml

kubectl -n ops-assistant-agent-prod create secret generic ops-assistant-agent-env \
  --from-env-file=.env.production.secret

kubectl -n ops-assistant-agent-prod create secret generic ops-assistant-agent-google \
  --from-file=key.json=/secure/path/google-key.json

kubectl apply -k deploy/k8s/production
```

The manifest deliberately omits Ingress, cloud IAM annotations, ExternalSecret,
NetworkPolicy and registry credentials because those are platform-owned choices.
Add them in a platform overlay rather than hard-coding company infrastructure
into the application base.

## Release checks

Before promoting an image:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm audit --prod
kubectl kustomize deploy/k8s/production >/tmp/ops-assistant-agent.yaml
```

After rollout, verify startup logs, `/health`, authenticated `/config/models`, a
dry-run or controlled real Agent request, persistent config after restart and
Langfuse trace delivery. The Docker/Kubernetes path is the deployment source of
truth; a host-only TypeScript build is not sufficient release evidence.
