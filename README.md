# Metering Plugin for Red Hat Developer Hub / Backstage

A dynamic plugin that queries OpenShift Prometheus for CPU, memory, and GPU
metrics, calculates hourly costs per catalog entity, persists historical data in
a three-tier database, and provides cost visualisation and monthly report
generation directly inside the entity page.

---

## Table of Contents

1. [Features](#1-features)
2. [Compatibility](#2-compatibility)
3. [Prerequisites](#3-prerequisites)
4. [Installation — RHDH (dynamic plugin)](#4-installation--rhdh-dynamic-plugin)
5. [Installation — Standard Backstage](#5-installation--standard-backstage)
6. [Configuration reference](#6-configuration-reference)
7. [Catalog annotations](#7-catalog-annotations)
8. [Prometheus metrics used](#8-prometheus-metrics-used)
9. [Permissions required](#9-permissions-required)
10. [Data storage model](#10-data-storage-model)
11. [Monthly cost reports](#11-monthly-cost-reports)
12. [Local development](#12-local-development)

---

## 1. Features

- **Live cost card** on the entity Overview tab — hourly cost with 1 h / 24 h / 7 d window selector
- **Resource efficiency gauge** — actual usage vs. requested resources (CPU, memory, GPU)
- **Cost breakdown donut chart** — CPU / memory / GPU cost split
- **6-month cost trend chart** — dual Y-axis (total monthly cost + avg hourly rate)
- **Three-tier data storage** — hourly snapshots → daily aggregates → monthly rollups; all three layers are kept forever (daily/monthly) or for a configurable retention window (hourly)
- **Monthly cost reports** — generated on demand for any available month, with daily bar chart, KPI summary cards, and download as CSV or PDF

---

## 2. Compatibility

| Platform | Supported | Notes |
|----------|-----------|-------|
| Red Hat Developer Hub 1.4+ | ✅ | Full dynamic-plugin support |
| Backstage 1.36+ | ✅ | See §5 — no dynamic-plugin packaging needed |
| OpenShift 4.12+ | ✅ | Prometheus `cluster-monitoring-view` role required |
| Vanilla Kubernetes | ✅ | Provide your own Prometheus URL and bearer token |
| PostgreSQL | ✅ | Recommended for production |
| SQLite | ✅ | Used automatically in local dev / rhdh-local |

**Backstage note:** The plugin source code uses only standard Backstage APIs
(`@backstage/backend-plugin-api`, `@backstage/frontend-plugin-api`,
`@backstage/plugin-catalog-react`). The dynamic-plugin packaging and OCI image
deployment are an RHDH-specific delivery mechanism; for standard Backstage the
plugin is installed as a regular npm package. See §5 for details.

---

## 3. Prerequisites

- A running **Prometheus** instance reachable from the Backstage/RHDH backend pod
- Catalog entities annotated with Kubernetes namespace + deployment name (§7)
- A service account with `cluster-monitoring-view` on OpenShift, or equivalent
  bearer-token access to Prometheus (§9)

---

## 4. Installation — RHDH (dynamic plugin)

### 4.1 Add to `dynamic-plugins.yaml`

```yaml
plugins:
  # Backend plugin — stores snapshots, serves /api/metering/* endpoints
  - package: oci://quay.io/edubois10/rhdh-plugin-metering-backend:0.1.0!internal-backstage-plugin-metering-backend
    disabled: false

  # Frontend plugin — Overview card + Metering tab
  - package: oci://quay.io/edubois10/rhdh-plugin-metering:0.1.0!internal-backstage-plugin-metering
    disabled: false
    pluginConfig:
      dynamicPlugins:
        frontend:
          internal.backstage-plugin-metering:
            apiFactories:
              - importName: meteringApiFactory
            mountPoints:
              - mountPoint: entity.page.overview/cards
                importName: MeteringSummaryCard
                config:
                  # Only render on entities with the Kubernetes namespace annotation.
                  # Without this filter the card appears on every entity in the
                  # catalog and shows a "missing annotations" placeholder instead
                  # of cost data, which is noisy in large catalogs.
                  if:
                    allOf:
                      - hasAnnotation: backstage.io/kubernetes-namespace
                  layout:
                    gridColumnEnd:
                      lg: span 4
                      md: span 6
                      xs: span 12
              - mountPoint: entity.page.metering/cards
                importName: MeteringTabContent
                config:
                  layout:
                    gridColumn: 1 / -1
            entityTabs:
              - path: /metering
                title: Metering
                mountPoint: entity.page.metering
                if:
                  allOf:
                    - hasAnnotation: backstage.io/kubernetes-namespace
```

The `hasAnnotation` condition is a **standard Backstage annotation check** —
the same `backstage.io/kubernetes-namespace` annotation used by the Backstage
Kubernetes plugin. Any entity that already works with the Kubernetes or Tekton
plugins will automatically get the Metering card and tab without any additional
configuration.

### 4.2 Add `metering` config block to `app-config.yaml`

See §6 for all available options.

### 4.3 Grant Prometheus access (OpenShift)

The backend pod has `automountServiceAccountToken: false` (RHDH operator
hardening). A dedicated service account with the Prometheus viewer role must be
created and its token sealed into `backstage-secrets`. The supplied Ansible
post-install playbook handles this automatically:

```bash
ansible-playbook ansible/playbooks/post-install.yml \
  --vault-password-file ansible/vault_pass \
  -e ocp_api_url=<cluster-api> \
  -e ocp_username=admin \
  -e ocp_password=<password> \
  --tags metering-prometheus-token
```

See §9 for the manual steps if not using the playbook.

---

## 5. Installation — Standard Backstage

The plugin source compiles with standard Backstage tooling. No dynamic-plugin
packaging is required.

### Backend

```bash
# In your Backstage monorepo
yarn add @internal/backstage-plugin-metering-backend
```

Register in `packages/backend/src/index.ts`:

```typescript
backend.add(import('@internal/backstage-plugin-metering-backend'));
```

### Frontend

```bash
yarn add @internal/backstage-plugin-metering
```

Register the API and add the tab in `packages/app/src/App.tsx`:

```typescript
import { meteringPlugin, MeteringTabContent, MeteringSummaryCard } from '@internal/backstage-plugin-metering';

// In createApp({ apis }):
createApiFactory({
  api: meteringApiRef,
  deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
  factory: ({ discoveryApi, fetchApi }) => new MeteringClient(discoveryApi, fetchApi),
}),

// On the EntityPage overview grid:
<EntitySwitch>
  <EntitySwitch.Case if={isKind('component')}>
    <MeteringSummaryCard />
  </EntitySwitch.Case>
</EntitySwitch>

// As a tab on EntityPage:
<EntityLayout.Route path="/metering" title="Metering">
  <MeteringTabContent />
</EntityLayout.Route>
```

---

## 6. Configuration reference

All settings live under the `metering` key in `app-config.yaml`.

```yaml
metering:
  # ── Required ────────────────────────────────────────────────────────────
  prometheusUrl: https://prometheus-k8s.openshift-monitoring.svc:9091
  # Base URL of the Prometheus instance queried for resource metrics.
  # On OpenShift this is the cluster-internal URL (no ingress needed).

  costModel:
    cpuCostPerCorePerHour: 0.048
    # USD charged per CPU core per hour. Tune to match your cloud/on-prem rates.

    memoryCostPerGBPerHour: 0.006
    # USD charged per GiB of memory per hour.

    gpuCostPerGpuPerHour: 0
    # USD per GPU-equivalent per hour. Set > 0 only when NVIDIA DCGM Exporter
    # is deployed. Example: 2.48 for an AWS p3.2xlarge V100 fraction.

  # ── Optional ─────────────────────────────────────────────────────────────
  bearerToken: "${METERING_PROMETHEUS_TOKEN}"
  # Bearer token sent in the Authorization header when querying Prometheus.
  # On OpenShift: use a service-account token with cluster-monitoring-view.
  # In local dev against a port-forwarded Prometheus: use `oc whoami --show-token`.
  # When omitted the plugin falls back to the pod's mounted SA token
  # (/var/run/secrets/kubernetes.io/serviceaccount/token). RHDH sets
  # automountServiceAccountToken: false, so the token MUST be provided explicitly.

  chargeMode: max
  # Which resource signal to bill against. Options:
  #   usage    — actual consumption reported by cAdvisor
  #   requests — Kubernetes scheduler reservations
  #   limits   — hard caps declared in the pod spec
  #   max      — higher of usage vs requests (default, discourages over-requesting)

  windowHours: 24
  # Lookback window in hours for the live cost queries on the Overview card
  # and the Metering tab (the 1 h / 24 h / 7 d selector overrides this at runtime).
  # Default: 24.

  retentionDays: 90
  # Hourly snapshot rows older than this are pruned by the hourly scheduler task.
  # Must be greater than rollupAfterDays. Default: 90.

  rollupAfterDays: 30
  # Hourly rows older than this are rolled up into daily and monthly aggregates
  # by the nightly task, then deleted. Must be less than retentionDays.
  # Set to 0 in local dev to force immediate rollup on the next scheduler cycle.
  # Default: 30.
```

### Environment variables referenced above

| Variable | Where to set | Description |
|----------|-------------|-------------|
| `METERING_PROMETHEUS_TOKEN` | `backstage-secrets` (SealedSecret) | Bearer token for Prometheus auth |

---

## 7. Catalog annotations

Add both annotations to any `Component` (or other kind) you want to track:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  annotations:
    backstage.io/kubernetes-namespace: my-namespace   # required
    backstage.io/kubernetes-id: my-deployment         # required
spec:
  type: service
  lifecycle: production
  owner: team-platform
```

| Annotation | Required | Description |
|-----------|----------|-------------|
| `backstage.io/kubernetes-namespace` | Yes | Kubernetes namespace where the workload runs |
| `backstage.io/kubernetes-id` | Yes | Deployment name (used in Prometheus pod selector `pod=~"<id>-[a-z0-9]+-[a-z0-9]+"`) |

**Cost attribution is deployment-scoped.** All pods matching the deployment name
regex are included in the cost calculation. During a rolling update, both old
and new pods are counted — which is technically correct (you are running double
the resources temporarily) and will appear as a brief cost spike in the charts.

---

## 8. Prometheus metrics used

The following Prometheus queries are issued once per hour per annotated entity.
All queries use the pod selector `namespace="<ns>",pod=~"<deployment>-[a-z0-9]+-[a-z0-9]+"`.

| Metric | Query | Purpose |
|--------|-------|---------|
| CPU usage | `sum(rate(container_cpu_usage_seconds_total{...}[<window>h]))` | Actual CPU consumption |
| Memory usage | `sum(container_memory_working_set_bytes{...})` | Actual memory working set |
| CPU requests | `sum(kube_pod_container_resource_requests{...,resource="cpu"})` | Scheduler reservation |
| Memory requests | `sum(kube_pod_container_resource_requests{...,resource="memory"})` | Scheduler reservation |
| CPU limits | `sum(kube_pod_container_resource_limits{...,resource="cpu"})` | Hard cap |
| Memory limits | `sum(kube_pod_container_resource_limits{...,resource="memory"})` | Hard cap |
| Replica count | `kube_deployment_status_replicas{namespace="<ns>",deployment="<id>"}` | Running replicas |
| GPU utilisation | `sum(DCGM_FI_DEV_GPU_UTIL{...}) / 100` | NVIDIA DCGM — returns 0 gracefully if exporter absent |
| GPU memory | `sum(DCGM_FI_DEV_FB_USED{...}) * 1048576` | NVIDIA DCGM — bytes used |

**Charge mode calculation:**

```
max  → bill on max(cpuUsage, cpuRequest) and max(memUsage, memRequest)
usage    → bill on actual usage only
requests → bill on scheduler requests only
limits   → bill on hard limits only
```

---

## 9. Permissions required

### OpenShift / Kubernetes RBAC

The Backstage backend pod needs to query Prometheus, which on OpenShift is
protected by an OAuth proxy.

**Declarative (recommended)** — apply the manifests in
`k8s/developer-hub/instance/metering-rbac.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: rhdh-metering-prometheus
  namespace: developer-hub
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: rhdh-cluster-monitoring-view
subjects:
  - kind: ServiceAccount
    name: rhdh-metering-prometheus
    namespace: developer-hub
roleRef:
  kind: ClusterRole
  name: cluster-monitoring-view
  apiGroup: rbac.authorization.k8s.io
```

Then create a long-lived token for the SA and provide it as `bearerToken` in the
config (see §6). The Ansible playbook `--tags metering-prometheus-token`
automates token creation, Sealed-Secret sealing, and git push.

**Why a dedicated SA?** RHDH's operator sets `automountServiceAccountToken: false`
on the Backstage pod as a security hardening measure, so the plugin cannot use
the pod's projected token. A named token from a dedicated SA is required.
Using a dedicated SA instead of the `default` SA scopes the Prometheus access
privilege to only the token the metering plugin holds.

### Backstage permission framework

Version 1.0 of this plugin does **not** integrate with Backstage's permission
framework. All authenticated Backstage users who can view an entity can also
view its metering data. If finer-grained access control is required, it can be
added in a future version via a custom permission policy.

---

## 10. Data storage model

The plugin uses a three-tier storage model in the Backstage PostgreSQL/SQLite
database (`backstage_plugin_metering`):

```
Tier 1  cost_snapshots         1 row / entity / hour    last rollupAfterDays (default 30 days)
Tier 2  cost_daily_aggregates  1 row / entity / day     forever
Tier 3  cost_monthly_rollups   1 row / entity / month   forever
```

**Nightly rollup job** (runs every 24 hours, 5-minute initial delay):

1. Groups hourly rows older than `rollupAfterDays` by calendar day → upserts into
   `cost_daily_aggregates` (additive, idempotent via `ON CONFLICT ... DO UPDATE`)
2. Groups those same rows by calendar month → upserts into `cost_monthly_rollups`
3. Deletes the source hourly rows

**Volume estimate:**

| Scale | Daily rows/year | Monthly rows/year | Storage |
|-------|----------------|-------------------|---------|
| 10 entities | 3,650 | 120 | ~200 KB |
| 100 entities | 36,500 | 1,200 | ~2 MB |
| 1,000 entities | 365,000 | 12,000 | ~20 MB |

Even at 1,000 entities running for 10 years the daily aggregate table stays
under 200 MB — negligible for PostgreSQL.

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/metering/health` | Health check (unauthenticated) |
| `GET` | `/api/metering/cost` | Live cost snapshot from Prometheus |
| `GET` | `/api/metering/cost/history` | Time-series history (3-tier UNION) |
| `GET` | `/api/metering/available-months` | Months with data for an entity |
| `GET` | `/api/metering/report` | Daily breakdown + summary for a month |

**Query parameters for `/cost`:**

| Param | Required | Description |
|-------|----------|-------------|
| `namespace` | Yes | Kubernetes namespace |
| `deployment` | Yes | Deployment name |
| `entityRef` | Yes | Full Backstage entity reference |
| `windowHours` | No | Lookback window in hours (default: config value) |

**Query parameters for `/cost/history`, `/available-months`, `/report`:**

| Param | Required | Description |
|-------|----------|-------------|
| `entityRef` | Yes | Full Backstage entity reference |
| `days` | No | History window in days for `/cost/history` (default: 30) |
| `month` | Yes (report) | `YYYY-MM` format |

---

## 11. Monthly cost reports

Reports are generated on demand from the stored data — no external service is
needed.

### Accessing the report

1. Open the **Metering** tab on any annotated entity
2. Click **Download Report** (top-right, next to the window selector)
3. Select a month from the picker — months with a full daily breakdown are shown
   normally; months with only a monthly aggregate are marked with an info icon
4. Click **Generate**
5. Download as **CSV** or **PDF**

### Report contents

**PDF layout:**

- Header with entity name (friendly) and full entity reference
- Row 1 KPI cards (blue — financial): Total Cost | Avg Daily Cost | Peak Day
- Row 2 KPI cards (green — resource): Avg CPU | Avg Memory | Data Points
- Daily cost bar chart
- Daily breakdown table (date, avg CPU, avg mem, daily cost, data points)
  — GPU column is hidden when no GPU data exists
  — all numbers right-aligned for easy vertical scanning

**CSV layout:**

- Header row + one row per day
- Monthly summary block at the bottom

### Data availability per month

| Month age | Daily breakdown | Monthly summary |
|-----------|----------------|----------------|
| < `rollupAfterDays` | Yes (from hourly snapshots) | Computed from daily rows |
| ≥ `rollupAfterDays` | Yes (from daily aggregates — always available) | From monthly rollup |
| Before plugin deployment | No | No |

---

## 12. Local development

### Prerequisites

- [rhdh-local](https://github.com/redhat-developer/rhdh-local) checked out
- Podman installed and logged in to `quay.io`
- `corepack enable` (for Yarn 4)

### Export and restart

Use the provided helper script to avoid hot-reload race conditions:

```bash
# From the plugin workspace root:
cd plugins/
./restart-rhdh-local.sh            # export + clean restart (recommended)
./restart-rhdh-local.sh --no-export  # restart only, skip export step
```

The script runs `export-dev.sh` → `compose down` → clears the
`dynamic-plugins-root` volume → `compose up -d`. This guarantees
`install-dynamic-plugins` finishes before RHDH starts — avoiding the
hot-reload race condition where the Metering tab disappears.

### Port-forward Prometheus for real data

```bash
oc port-forward -n openshift-monitoring svc/prometheus-k8s 9091:9091
```

Set the bearer token in `rhdh-local/.env` (gitignored):

```
METERING_PROMETHEUS_TOKEN=<output of `oc whoami --show-token`>
```

### Seed 6 months of fake data

```python
# Run against rhdh-local's SQLite database to populate historical data
# (see scripts/seed-metering-data.py in the repository)
python3 scripts/seed-metering-data.py
```

### Build and push OCI images

```bash
cd plugins/
./build-oci.sh                            # uses defaults
./build-oci.sh --registry quay.io/myorg  # custom registry
./build-oci.sh --tag 1.2.0               # custom tag
```

Repositories must be set to **Public** on quay.io before RHDH can pull
without cluster-level image pull secrets.

---

## Metrics source compatibility

The plugin queries the **Prometheus HTTP API** (`/api/v1/query`). Any system
that exposes this API with the same metric names works without code changes:

| Source | Compatible | Notes |
|--------|-----------|-------|
| OpenShift Prometheus | ✅ | Default — port 9091 with OAuth proxy |
| Thanos Querier | ✅ | OpenShift already routes `:9091` through Thanos |
| VictoriaMetrics | ✅ | Drop-in Prometheus API |
| Grafana Mimir / Cortex | ✅ | Prometheus-compatible |
| AWS Managed Service for Prometheus | ✅ | Same API — configure SigV4 bearer token |
| GCP Managed Prometheus | ✅ | Same API — use GCP service-account token |
| Datadog | ❌ | Different query API — would need a new client |
| Dynatrace | ❌ | Different query API |
| New Relic | ❌ | Different query API |
| InfluxDB | ❌ | Different query language (Flux/InfluxQL) |

The underlying metrics (`container_cpu_usage_seconds_total`,
`kube_pod_container_resource_requests`, etc.) come from **cAdvisor** and
**kube-state-metrics**, which are deployed by default in every Kubernetes
monitoring stack. Any Prometheus-compatible backend that scrapes those exporters
will have the required metrics.

For a future v2, abstracting `PrometheusClient` behind a `MetricsClient`
interface would allow pluggable backends for non-Prometheus systems.

## Backstage compatibility — extended note

The plugin source code is written against standard Backstage APIs and is
**fully compatible with standard Backstage** at the code level. The differences
are in how it is packaged and deployed:

| Aspect | RHDH | Standard Backstage |
|--------|------|-------------------|
| Packaging | OCI image via `rhdh-cli plugin export` | Regular npm package in monorepo |
| Loading | `install-dynamic-plugins` init container reads `dynamic-plugins.yaml` | Registered in `packages/backend/src/index.ts` and `App.tsx` |
| Frontend wiring | `mountPoints` / `entityTabs` in plugin config YAML | `EntityLayout.Route` and grid components in `App.tsx` |
| Module federation | `scalprum` config in `package.json` | Not needed |
| Prometheus auth | Sealed-Secret token (RHDH operator sets `automountServiceAccountToken: false`) | Mounted SA token or env var |

For standard Backstage deployment, ignore the `scalprum` config, the
`dist-dynamic/` build artifacts, and the OCI packaging steps. Install the
packages normally via yarn and register them as you would any Backstage plugin.
