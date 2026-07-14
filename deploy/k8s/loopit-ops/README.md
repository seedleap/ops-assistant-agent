# loopit-ops platform prerequisites

The Loopit platform owns the application StatefulSet, Service, environment,
probes, routing, swimlanes, and CD. This directory contains only the shared
storage prerequisite that must exist before the first platform deployment.

`prerequisites.yaml` binds the `ops-assistant-agent-data` RWX claim to an
isolated EFS access point. The baseline workload uses `/app/data/default` and
each feature lane must set `DATA_DIR` and related paths under its own
`/app/data/<lane>` directory.

Apply with the explicit cluster context:

```bash
kubectl --context loopit-ops apply -f deploy/k8s/loopit-ops/prerequisites.yaml
```
