# How to Build a Dynamic Plugin for Red Hat Developer Hub

This is a practical guide to the concepts and files involved in building an
RHDH plugin, using the **metering plugin** in this repo
(`plugins/metering` + `plugins/metering-backend`) as the running example.
It intentionally skips step-by-step CLI transcripts — see
[`plugins/README.md`](./README.md) for that — and focuses on *what each
piece is for* and *where to find it*.

## 1. Pin your versions first

RHDH bundles a specific Backstage core version, and every `@backstage/*`
package you install must be compatible with it. Getting this wrong is the
#1 source of confusing dependency-resolution and TypeScript errors when
scaffolding a plugin. Check versions in this order:

1. **Which RHDH version are you targeting?** (e.g. RHDH 1.10). Check the
   [RHDH release notes](https://docs.redhat.com/en/documentation/red_hat_developer_hub)
   for the Backstage version it's built on.
2. **Pin that Backstage version** in `backstage.json` at the workspace root
   — the `@backstage/cli` reads this to pick compatible tooling defaults:

   ```1:3:plugins/backstage.json
   {
     "version": "1.49.4"
   }
   ```

3. **Find compatible `@backstage/*` package versions** for that Backstage
   release. The safest way is `npm view @backstage/<package> versions` and
   cross-checking against the
   [Backstage versioning page](https://backstage.io/docs/releases/), rather
   than guessing at `^latest`. All the metering plugin's runtime deps were
   pinned this way, e.g.:

   ```17:27:plugins/metering-backend/package.json
     "dependencies": {
       "@backstage/backend-plugin-api": "^1.9.2",
       "@backstage/catalog-model": "^1.9.0",
       "@backstage/config": "^1.3.8",
       "@backstage/errors": "^1.3.1",
       "@backstage/plugin-catalog-node": "^2.2.2",
       "express": "^4.21.2",
       "express-promise-router": "^4.1.1",
       "knex": "^3.1.0",
       "lru-cache": "^11.5.1",
       "zod": "^3.25.76"
     },
   ```

4. **Check Node.js / Yarn / TypeScript requirements.** `@backstage/cli`
   documents a minimum Node major version per release — declare it in
   `engines` and pin the package manager so CI and local dev can't drift:

   ```22:25:plugins/package.json
     "packageManager": "yarn@4.8.1",
     "engines": {
       "node": "22 || 24"
     }
   ```

5. **Decide New Frontend System (NFS) vs legacy.** RHDH 1.10 / Backstage
   1.49 frontend plugins should use `createFrontendPlugin()` +
   `ApiBlueprint` from `@backstage/frontend-plugin-api` (NFS), not the
   older `createPlugin()`/`createApiFactory`-only pattern. This changes
   which files/exports you need — see §4 below.

Mismatched versions usually surface as either `yarn install` peer-dependency
errors, or `@backstage/cli` failing to find "CLI modules" — both are a sign
to re-check this section before debugging further.

## 2. Workspace-level files (apply to every plugin you add)

A plugin workspace is a Yarn workspace containing one package per plugin.
These four files live at `plugins/` and are shared by all plugins in it:

| File | Purpose |
|---|---|
| [`package.json`](./package.json) | Declares the `workspaces` array (one entry per plugin package) and workspace-wide `foreach` scripts (`build:all`, `test:all`, ...). |
| [`backstage.json`](./backstage.json) | Pins the Backstage version (see §1). |
| [`tsconfig.json`](./tsconfig.json) | Base TypeScript config every package extends. |
| [`.yarnrc.yml`](./.yarnrc.yml) | `nodeLinker: node-modules` — required so `@backstage/cli`'s Jest tooling can resolve dependencies. Yarn's default PnP linker breaks `backstage-cli package test`. |

Adding a new plugin means adding its directory name to the `workspaces`
array here — nothing else at this level changes.

## 3. Anatomy of one plugin package

Each plugin is its own package under `plugins/<name>/`. A **backend**
plugin and a **frontend** plugin package look slightly different, but both
need:

- `package.json` with a `backstage.role` field (`backend-plugin` or
  `frontend-plugin`) so tooling (and humans) know what kind of plugin it is.
- `tsconfig.json` extending the workspace root config.
- A `src/` directory with an `index.ts` (public API) and a `plugin.ts`
  (registration — see §4).

### Backend package (`plugins/metering-backend/package.json`)

```1:16:plugins/metering-backend/package.json
{
  "name": "@internal/backstage-plugin-metering-backend",
  "version": "0.1.0",
  "description": "Backstage backend plugin for application metering — queries Prometheus for CPU/memory metrics and calculates cost",
  "private": true,
  "backstage": {
    "role": "backend-plugin"
  },
  "scripts": {
    "build": "backstage-cli package build",
    "build:types": "tsc --declaration --emitDeclarationOnly",
    "tsc": "backstage-cli package lint",
    "lint": "backstage-cli package lint",
    "test": "backstage-cli package test",
    "clean": "backstage-cli package clean"
  },
```

Backend-specific files worth knowing:

- [`config.schema.json`](./metering-backend/config.schema.json) — a
  declarative JSON Schema describing the plugin's `app-config.yaml` block.
  RHDH surfaces this in its config-schema tooling and it's how the
  `files` array (`"config.schema.json"`) ships the schema with the built
  package.
- `src/database.ts` — Knex migration runner + all DB query helpers. See
  §4.5 for the full two-tier storage pattern introduced in EPIC 3.

### Frontend package (`plugins/metering/package.json`)

```38:54:plugins/metering/package.json
  "files": [
    "dist",
    "dist-dynamic"
  ],
  "main": "dist/index.esm.js",
  "module": "dist/index.esm.js",
  "types": "dist/index.d.ts",
  "scalprum": {
    "name": "internal.backstage-plugin-metering",
    "exposedModules": {
      "PluginRoot": "./src/index.ts"
    }
  }
}
```

The `scalprum` block is **the single most important frontend-only field**:
it's what turns a normal Backstage frontend package into a *dynamically
loadable* module federation remote. `exposedModules.PluginRoot` tells the
RHDH shell "load `src/index.ts` and expose everything it exports" — those
exports are what `importName` in `dynamic-plugins.yaml` refers to later
(§6).

## 4. Where the plugin implementation actually runs

This is the part that's easy to get lost in: a plugin package can have
many files, but only **one file per package registers the plugin with
Backstage's dependency-injection runtime**. Everything else is a regular
module imported by that file.

### Backend: `src/plugin.ts` + `registerInit`

`createBackendPlugin()` describes *what services the plugin needs*
(`deps`) and provides an `init()` function that runs once, at backend
startup, after those services are resolved:

```1:30:plugins/metering-backend/src/plugin.ts
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { Knex } from 'knex';
import { createRouter } from './router';
import { createSnapshotScheduler } from './snapshotScheduler';
import { runMigrations } from './database';
import { meteringConfigSchema } from './types';

const meteringPlugin = createBackendPlugin({
  pluginId: 'metering',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({ httpRouter, logger, config, database, scheduler, auth, catalog }) {
        const rawConfig = config.getOptionalConfig('metering');
        if (!rawConfig) {
          logger.warn(
            'Metering plugin: no config found under "metering". Plugin is disabled.',
          );
          return;
        }
```

Everything `init()` does is composition, not implementation: it validates
config (`meteringConfigSchema`, §5), runs DB migrations
(`runMigrations` from `database.ts`), starts two scheduled jobs
(`createSnapshotScheduler` registers both the hourly snapshot task and
the nightly monthly-rollup task — see §4.5), and mounts an Express router
(`createRouter` from `router.ts`) on the shared `httpRouter` service:

```71:77:plugins/metering-backend/src/plugin.ts
        // Mount REST router under /api/metering
        const router = createRouter(meteringConfig, logger, knex);
        httpRouter.use(router);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
```

The actual HTTP handlers live in `src/router.ts`, a plain function that
returns an Express router — it doesn't know anything about Backstage's
plugin system:

```16:34:plugins/metering-backend/src/router.ts
export function createRouter(
  config: MeteringConfig,
  logger: LoggerService,
  knex: Knex,
): ExpressRouter {
  const router = Router();

  const prometheusClient = new PrometheusClient(config.prometheusUrl, logger);
  const costCalculator = new CostCalculator(config);

  // 5-minute LRU cache keyed on namespace+deployment+window
  const cache = new LRUCache<string, CostResult>({
    max: 200,
    ttl: 5 * 60 * 1000,
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });
```

Finally, `src/index.ts` re-exports the plugin as the package's `default`
export — this is the file Backstage's backend loader actually imports:

```1:2:plugins/metering-backend/src/index.ts
export { default } from './plugin';
export * from './types';
```

**Rule of thumb:** if you're adding a new backend capability, you almost
always add a new file (`router.ts`, `database.ts`, a new service class...)
and wire it into `plugin.ts`'s `init()` — you rarely need to touch
`index.ts`.

### Frontend: `src/plugin.ts` + `createFrontendPlugin`

The New Frontend System equivalent is `createFrontendPlugin()`, which
takes a list of `extensions` (APIs, pages, cards, etc.) instead of an
imperative `init()`:

```1:19:plugins/metering/src/plugin.ts
import {
  createFrontendPlugin,
  ApiBlueprint,
} from '@backstage/frontend-plugin-api';
import { meteringApiFactory } from './api';
import { MeteringCardContent } from './components/MeteringCard';

// Named export used as importName in dynamic-plugins.yaml pluginConfig
export { MeteringCardContent as MeteringCard };

const MeteringApiBlueprint = ApiBlueprint.make({
  name: 'metering-api',
  params: defineParams => defineParams(meteringApiFactory),
});

export default createFrontendPlugin({
  pluginId: 'metering',
  extensions: [MeteringApiBlueprint],
});
```

Here, the only "extension" registered is the plugin's API client
(`meteringApiFactory`, defined in `src/api.ts`). The actual UI —
`MeteringCardContent` — isn't registered as an extension at all; instead
it's exported by name and mounted declaratively later via
`dynamic-plugins.yaml`'s `mountPoints` (§6). This is a common pattern for
dynamic plugins: keep `plugin.ts` minimal (APIs + routing extensions only)
and let the host app config decide where components are mounted.

`src/index.ts` re-exports everything a consumer (or the dynamic plugin
loader) might need:

```1:4:plugins/metering/src/index.ts
export { default as meteringPlugin, MeteringCard } from './plugin';
export { MeteringCardContent } from './components/MeteringCard';
export { meteringApiRef } from './api';
export type { CostResult, CostHistoryPoint, MeteringApi } from './api';
```

## 4.5 Database persistence pattern

If your plugin needs to store data between requests (cost snapshots, usage
history, etc.) you use Backstage's `DatabaseService`, which hands you a
Knex client wired to whatever database the RHDH instance has configured
(PostgreSQL in production, SQLite in local dev and tests).

### Migrations

Schema changes live in numbered files under `src/migrations/`:

```
migrations/
  001_initial_cost_snapshots.ts   ← creates cost_snapshots + index
  002_add_gpu_columns.ts          ← ALTER TABLE — adds gpu_count/gpu_cost
  003_create_cost_monthly_rollups.ts  ← ADR-05 two-tier storage table
```

Each file exports `up(knex)` (and optionally `down(knex)`).

**Critical: use static imports, not directory scan.** The Backstage CLI build
only compiles files reachable via static imports. A `path.resolve(__dirname,
'migrations')` directory scan works in local TypeScript dev (where `src/` is
live on disk) but fails in the compiled `dist-dynamic/` bundle because
`dist/migrations/` is never created — RHDH crashes on startup with `ENOENT:
no such file or directory, scandir ...dist/migrations`.

The correct pattern uses Knex's `migrationSource` API with explicit imports so
the build tool bundles every migration into the compiled output:

```typescript
import * as migration001 from './migrations/001_initial_cost_snapshots';
import * as migration002 from './migrations/002_add_gpu_columns';
import * as migration003 from './migrations/003_create_cost_monthly_rollups';

const MIGRATIONS = [
  { name: '001_initial_cost_snapshots',      module: migration001 },
  { name: '002_add_gpu_columns',             module: migration002 },
  { name: '003_create_cost_monthly_rollups', module: migration003 },
] as const;

const migrationSource = {
  getMigrations: () => Promise.resolve([...MIGRATIONS]),
  getMigrationName: (m: (typeof MIGRATIONS)[number]) => m.name,
  getMigration:     (m: (typeof MIGRATIONS)[number]) => Promise.resolve(m.module),
};

export async function runMigrations(knex: Knex): Promise<void> {
  await knex.migrate.latest({ migrationSource });
}
```

To add a new migration: create the file, add it to the imports and the
`MIGRATIONS` array. Knex tracks applied migrations in a `knex_migrations`
table — the call is idempotent and safe on every startup.

### Two-tier storage (ADR-05)

The metering plugin uses two tables with different retention policies,
avoiding unbounded growth while preserving long-term trend data:

| Table | Granularity | Lifetime | Purpose |
|-------|-------------|----------|---------|
| `cost_snapshots` | 1 row / entity / hour | `rollupAfterDays` (default 30 d) | Live cost card, current billing window |
| `cost_monthly_rollups` | 1 row / entity / month | indefinite | Long-term trend charts, budget reporting |

A **nightly rollup task** (registered alongside the hourly snapshot task in
`snapshotScheduler.ts`) aggregates hourly rows older than `rollupAfterDays`
into monthly aggregates and deletes the source rows.

The `getHistory()` function transparently **UNIONs** both tables and returns
a single sorted `CostSnapshot[]`, so the router and frontend see one
unified time series regardless of data age.

### Dialect-aware SQL

SQLite (local dev / tests) and PostgreSQL (production) handle date
truncation differently. The helper at the top of `database.ts` abstracts
this:

```typescript
function monthTruncExpr(knex: Knex, column: string): string {
  return isSQLite(knex)
    ? `strftime('%Y-%m-01', ${column})`       // SQLite
    : `date_trunc('month', ${column})::date`; // PostgreSQL
}
```

This pattern should be used for any aggregate query that needs to group by
calendar period. The dialect is detected from `knex.client.config.client`.

### Date serialization

SQLite stores timestamps as plain text and compares them lexicographically.
Passing a JavaScript `Date` object directly to a Knex `where()` clause
produces inconsistent comparisons because Knex may serialize it as a
locale-dependent string or a Unix timestamp. **Always call `.toISOString()`**
before using a Date in a query:

```typescript
// Correct — works on both SQLite and PostgreSQL
.where('sampled_at', '>=', since.toISOString())

// Wrong — produces correct results on PostgreSQL but silently fails on SQLite
.where('sampled_at', '>=', since)
```

The same applies to values written into the table:

```typescript
sampled_at: new Date().toISOString()  // ✓
sampled_at: new Date()                // ✗ unreliable on SQLite
```

### Additive upsert

When the nightly rollup runs on consecutive nights for the same calendar
month, it must *add* each night's new slice to the stored aggregate rather
than overwrite it. A plain `.merge()` generates `ON CONFLICT ... DO UPDATE
SET col = excluded.col` for every column — a full overwrite that discards
the previously accumulated data. Use explicit additive expressions instead:

```typescript
.onConflict(['entity_ref', 'month_start'])
.merge({
  total_cost: knex.raw('cost_monthly_rollups.total_cost + excluded.total_cost'),
  sample_count: knex.raw('cost_monthly_rollups.sample_count + excluded.sample_count'),
  avg_cpu_cores: knex.raw(
    '(cost_monthly_rollups.avg_cpu_cores * cost_monthly_rollups.sample_count' +
    ' + excluded.avg_cpu_cores * excluded.sample_count)' +
    ' / (cost_monthly_rollups.sample_count + excluded.sample_count)',
  ),
  // same weighted-average pattern for avg_mem_gib, avg_gpu_count
})
```

The `excluded` pseudo-table is supported identically by both SQLite and
PostgreSQL in `ON CONFLICT ... DO UPDATE` clauses.

## 4.6 Frontend charts (Recharts)

The metering plugin uses **Recharts** for cost visualisation. Recharts was
chosen because it has a declarative React API, tree-shakes well (~150 KB
for the components actually used), and its colour and font props accept
plain strings that integrate naturally with the Material UI palette used
everywhere else in the plugin.

### Two chart components

| Component | Chart type | Data source |
|-----------|-----------|-------------|
| `CostDonut` | `PieChart` with `innerRadius` (donut) | `costState.value` — live Prometheus snapshot |
| `CostTrendChart` | `LineChart` | `historyState.value` — 30-day `/cost/history` series |

Both live under `src/components/MeteringTabContent/` and are mounted
inside `MeteringTabContent` as InfoCard children.

### Data already in the hook

`useMeteringData(windowHours)` fetches **both** the live cost snapshot and
the history series on every render:

```typescript
const costState   = useAsync(() => meteringApi.getCost({ ... }), [...]);
const historyState = useAsync(() => meteringApi.getCostHistory({ entityRef, days: 30 }), [...]);
```

Both `AsyncState` objects (`{ value, loading, error }`) are returned from
the hook and destructured in `MeteringTabContent`:

```typescript
const { namespace, deployment, costState, historyState, averages } =
  useMeteringData(windowHours);
```

This means adding a new chart never requires a new API call — the data is
already available. Just destructure the relevant state and pass it as a prop.

### CostDonut — PieChart (donut) for cost split

`CostDonut` takes a `CostResult` and renders a donut PieChart with one
slice per resource type (CPU / Memory / GPU). The GPU slice is omitted
automatically when `gpuCostPerHour === 0`:

```typescript
const slices = SLICE_DEFS
  .map(d => ({ name: d.name, value: d.getVal(cost), color: d.color }))
  .filter(s => s.value > 0);   // hide zero-cost resource types
```

### CostTrendChart — LineChart for 30-day history

`CostTrendChart` receives the `historyState` object directly and renders
a `LineChart` of `hourlyCost` over time. The history data comes from
`getHistory()` on the backend, which UNIONs hourly snapshots and monthly
rollup rows transparently — the chart sees a single sorted series
regardless of how old the data is:

```typescript
const data: ChartPoint[] = points.map(p => ({
  label: formatAxisDate(p.sampledAt),   // "Jun 15", "May 1", ...
  cost: p.hourlyCost,
}));
```

### Graceful states

Every chart component handles all three non-data states before rendering:

```typescript
if (historyState.loading) return <Progress />;
if (historyState.error)   return <Typography color="error">...</Typography>;
if (points.length === 0)  return <Typography color="textSecondary">...</Typography>;
// only now render the chart
```

This pattern must be followed for every chart — Recharts will silently
render an empty SVG if passed an empty `data` array, which looks broken
rather than informative.

### Custom tooltip — avoid importing `TooltipProps` from recharts

Recharts ships TypeScript types, but the `TooltipProps` generic changed
between major versions (v2 → v3). Importing it directly will break type
checking when recharts is upgraded. Instead, define a minimal local
interface that matches only the props your tooltip actually uses:

```typescript
// Instead of: import type { TooltipProps } from 'recharts';
interface DonutTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number }>;
}

function DonutTooltip({ active, payload }: DonutTooltipProps) {
  if (!active || !payload?.length) return null;
  // ...
}
```

Pass the component via the `content` prop:
```tsx
<Tooltip content={<DonutTooltip />} />
```

Recharts injects `active`, `payload`, and `label` at runtime regardless of
what TypeScript type the component declares — the local interface is just
for compile-time safety.

## 5. Config schema validation

Two layers validate plugin config, and it's worth knowing both:

1. **`config.schema.json`** (declarative, JSON Schema) — ships with the
   package so RHDH's config tooling can validate `app-config.yaml` and
   generate docs, without running any plugin code:

   ```1:13:plugins/metering-backend/config.schema.json
   {
     "$schema": "http://json-schema.org/draft-07/schema#",
     "title": "Metering Plugin Config",
     "type": "object",
     "properties": {
       "metering": {
         "type": "object",
         "required": ["prometheusUrl", "costModel"],
         "properties": {
           "prometheusUrl": {
             "type": "string",
             "description": "Base URL of the Prometheus instance (e.g. https://prometheus-k8s.openshift-monitoring.svc:9091)"
           },
   ```

2. **A Zod schema in code** (`meteringConfigSchema` in `src/types.ts`) —
   used at plugin *startup* inside `plugin.ts`'s `init()` to fail fast
   with a precise error if a required value is missing or the wrong type,
   before any request handler runs. This is the one that actually gates
   whether the plugin does anything at runtime.

Both describe the same shape; the JSON Schema is metadata for tooling, the
Zod schema is the runtime guard.

When fields have **cross-field constraints** (e.g. one value must be less
than another), add a `.refine()` on the Zod object rather than a custom
parser in `init()`. This keeps validation co-located with the schema
definition and produces a clear error message at startup:

```typescript
export const meteringConfigSchema = z
  .object({ ... })
  .refine(data => data.rollupAfterDays < data.retentionDays, {
    message:
      'rollupAfterDays must be less than retentionDays — otherwise ' +
      'pruneOldSnapshots will hard-delete hourly rows before they reach ' +
      'the rollup cutoff, causing silent data loss',
    path: ['rollupAfterDays'],
  });
```

Document the same constraint in `config.schema.json`'s `description` field
so operators see it at config-authoring time, not only at plugin startup.

## 6. Packaging as a *dynamic* plugin and loading it in RHDH

### 6.1 Standard Backstage vs RHDH dynamic plugins

In **standard Backstage** plugins are source code compiled into the
monorepo and baked into the main application Docker image. Adding or
updating a plugin means rebuilding the entire `app` image, pushing it, and
rolling the deployment. You own and maintain the image.

In **RHDH dynamic plugins** the plugin lives in its own OCI image,
completely decoupled from RHDH. At every pod startup an init container
(`install-dynamic-plugins`) reads a ConfigMap (`dynamic-plugins.yaml`),
pulls each plugin OCI image, extracts the `dist-dynamic/` directory, and
places it in a shared volume that the main RHDH container reads from. RHDH
itself never changes; only the plugin image changes.

```
Standard Backstage             RHDH dynamic plugins
─────────────────────          ────────────────────────────────────────
Plugin source ──►              Plugin source ──►
  app image                      dist-dynamic/ ──► OCI image
     │                                                │
     ▼                           ConfigMap lists OCI refs
  Deploy RHDH                          │
  (contains plugin)             init container pulls image
                                       │
                                  shared volume
                                       │
                                  RHDH reads plugins
```

Key differences:

| | Standard Backstage | RHDH dynamic plugin |
|--|--|--|
| Plugin update | Rebuild + redeploy RHDH | Push new OCI image, update ConfigMap |
| RHDH image | Changes every plugin release | Never changes for plugin updates |
| Versioning | Same version as RHDH app | Independent semver per plugin |
| Local dev | `yarn dev` in monorepo | `plugin export --dev` into rhdh-local |

### 6.2 What the OCI image contains

The OCI image is a **data-only artifact** built `FROM scratch` — it has no
OS, no runtime, no shell. It exists purely as a transport mechanism for the
compiled plugin files:

```
OCI image filesystem (FROM scratch)
├── package.json              ← plugin manifest
├── dist/                     ← compiled backend (or dist-scalprum/ for frontend)
│   ├── index.cjs.js
│   ├── database.cjs.js
│   └── ...
└── node_modules/             ← private deps bundled at export time
```

The image also carries an OCI annotation (`io.backstage.dynamic-packages`)
that encodes a JSON manifest of the plugins inside the image. The
`install-dynamic-plugins` init container reads this annotation to know
what it's installing without having to inspect the filesystem first.

The init container extracts the image contents into the
`dynamic-plugins-root` volume. RHDH scans that volume at startup and loads
whatever plugins it finds there.

### 6.3 How ArgoCD fits in

ArgoCD **never touches OCI images directly**. The connection runs through a
ConfigMap:

```
Git repo (dynamic-plugins.yaml)
    │
    ▼
ArgoCD (wave 3) ──► ConfigMap applied to cluster
                         │
                         ▼
                   install-dynamic-plugins init container
                   reads ConfigMap, pulls OCI images
                         │
                         ▼
                   dynamic-plugins-root volume
                         │
                         ▼
                   RHDH loads plugins from volume
```

`k8s/developer-hub/instance/dynamic-plugins.yaml` is a ConfigMap that
ArgoCD manages as part of wave 3. When you update an OCI image ref in that
file and push to git, ArgoCD applies the updated ConfigMap. The next time
the RHDH pod restarts, `install-dynamic-plugins` reads the new ref, pulls
the new plugin image, and installs it. ArgoCD's role is purely
"apply a YAML file" — the OCI pull happens entirely inside the cluster.

### 6.4 Plugin config wiring

Two things control how a dynamic plugin is loaded:

- The `scalprum` config in the frontend `package.json` (§3), which is what
  the export command reads to know what to expose as a module-federation
  remote.
- `dynamic-plugins.yaml`, which tells RHDH *which* packages to load and,
  for frontend plugins, *where in the UI* to mount their exported components:

  ```68:89:k8s/developer-hub/instance/dynamic-plugins.yaml
        - package: oci://quay.io/<your-org>/rhdh-plugin-metering-backend:1.0.0!internal-backstage-plugin-metering-backend
          disabled: false

        - package: oci://quay.io/<your-org>/rhdh-plugin-metering:1.0.0!internal-backstage-plugin-metering
          disabled: false
          pluginConfig:
            dynamicPlugins:
              frontend:
                internal.backstage-plugin-metering:
                  mountPoints:
                    - mountPoint: entity.page.overview/cards
                      importName: MeteringSummaryCard
                      config:
                        layout:
                          gridColumnEnd:
                            lg: span 4
                            md: span 6
                            xs: span 12
                  entityTabs:
                    - path: /metering
                      title: Metering
                      mountPoint: entity.page.metering
  ```

Note how `internal.backstage-plugin-metering` (the frontend config key)
matches `scalprum.name` from `package.json`, and `importName:
MeteringSummaryCard` matches the named export from `plugin.ts` — these
string values are the contract between your plugin code and the host
config, and there's no compiler to catch a typo in either, so
double-check them if a mounted card doesn't show up.

### 6.5 Packaging and pushing OCI images with the RHDH CLI

Red Hat provides an official CLI command that handles the entire packaging
pipeline in one step — no Containerfile needed:

```
plugin export        ← compile + bundle into dist-dynamic/
     │
     ▼
plugin package       ← build FROM scratch OCI image + add annotations
     │
     ▼
podman push          ← publish to registry
     │
     ▼
dynamic-plugins.yaml ← reference the OCI image by tag + plugin name
     │
     ▼
ArgoCD sync          ← applies ConfigMap to cluster
     │
     ▼
install-dynamic-plugins init container ← pulls image, extracts plugin
```

#### Step 1 — Export

`plugin export` compiles the TypeScript source and bundles all private
dependencies into `dist-dynamic/`. Run it from the plugin's package
directory:

```bash
cd plugins/metering-backend
npx @red-hat-developer-hub/cli@1.10 plugin export --clean
```

For a production build this compiles all files — including migration files
referenced via static imports — into the `dist/` directory inside
`dist-dynamic/`. The `--clean` flag removes any previous export first.

#### Step 2 — Package as OCI image

`plugin package` reads `dist-dynamic/`, stages the content, and runs:

```
FROM scratch
COPY . .
```

It also adds an `io.backstage.dynamic-packages` OCI annotation that encodes
a JSON manifest of the plugins inside the image. The `install-dynamic-plugins`
init container uses this annotation to identify plugins without scanning the
filesystem.

```bash
export QUAY_USER=edubois10
export PLUGIN=metering-backend
export VERSION=$(cat package.json | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")

npx @red-hat-developer-hub/cli@1.10 plugin package \
  --force-export \
  --tag quay.io/${QUAY_USER}/rhdh-plugin-${PLUGIN}:${VERSION}
```

`--force-export` re-runs the export even if `dist-dynamic/` already exists,
ensuring a clean build. Without it, `plugin package` reuses an existing
`dist-dynamic/` if present.

The command prints the exact `dynamic-plugins.yaml` snippet to use, including
the `!plugin-name` suffix:

```
plugins:
  - package: oci://quay.io/edubois10/rhdh-plugin-metering-backend:0.1.0!internal-backstage-plugin-metering-backend
    disabled: false
```

The `!plugin-name` suffix identifies which plugin to extract when an OCI
image bundles multiple plugins. Always use the value the CLI prints — do
not guess it.

#### Step 3 — Push

```bash
podman push quay.io/${QUAY_USER}/rhdh-plugin-${PLUGIN}:${VERSION}
```

#### Step 4 — Make the repository public

The RHDH cluster pulls plugin images without any image pull secret by
default. The quay.io repository **must be set to Public** (Settings →
Repository Visibility) before the cluster can pull.

#### Step 5 — Update `dynamic-plugins.yaml` and push to git

Update `k8s/developer-hub/instance/dynamic-plugins.yaml` with the OCI ref
from step 2 and set `disabled: false`. Commit and push — ArgoCD picks up
the change automatically on the next sync cycle.

#### Automated script

All five steps for both plugins are automated in
[`plugins/build-oci.sh`](./build-oci.sh):

```bash
cd ~/PersonalProject/developer-hub-env/plugins
./build-oci.sh                            # uses defaults (quay.io/edubois10, version from package.json)
./build-oci.sh --registry quay.io/myorg  # custom registry
./build-oci.sh --tag 1.2.0               # custom tag
```

### 6.6 Authenticating the backend plugin to OpenShift Prometheus

#### The problem — `automountServiceAccountToken: false`

The RHDH operator sets `automountServiceAccountToken: false` on the
Backstage pod as a security hardening measure. This means
`/var/run/secrets/kubernetes.io/serviceaccount/token` **does not exist**
inside the container. Any backend plugin that falls back to reading that
file for authenticating to cluster services (e.g. Prometheus, which is
protected by OpenShift's oauth-proxy) will send an empty `Authorization`
header and receive `401 Unauthorized`.

The metering plugin's `PrometheusClient` uses exactly this fallback:

```typescript
private getToken(): string {
  if (this.bearerToken) return this.bearerToken;  // config takes precedence
  try {
    return fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim(); // not mounted → ''
  } catch { return ''; }
}
```

Without a token in the config, every Prometheus query fails with 401.

#### The solution — dedicated SA + long-lived token + SealedSecret

The pattern mirrors what the Kubernetes plugin already does for
`K8S_SERVICE_ACCOUNT_TOKEN`:

```
1. Dedicated ServiceAccount (cluster-monitoring-view role)  [declarative YAML]
      │
      ▼
2. Long-lived token created by post-install playbook        [per-cluster automation]
      │
      ▼
3. Token sealed with kubeseal → backstage-secrets           [committed to git]
      │
      ▼
4. app-config.yaml: bearerToken: ${METERING_PROMETHEUS_TOKEN}  [declarative]
      │
      ▼
5. ArgoCD syncs → RHDH pod has the env var → Prometheus accepts the token
```

#### Declarative pieces (in git)

**`k8s/developer-hub/instance/metering-rbac.yaml`** — creates the SA and
grants the required ClusterRole:

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

**`k8s/developer-hub/instance/app-config.yaml`** — tells the plugin to use
the token from the environment:

```yaml
metering:
  prometheusUrl: https://prometheus-k8s.openshift-monitoring.svc:9091
  bearerToken: "${METERING_PROMETHEUS_TOKEN}"
```

#### Per-cluster automation (post-install playbook)

ArgoCD creates the SA on first sync. Once the SA exists, run the
`metering-prometheus-token` tag to create a long-lived token, seal it with
the cluster's Sealed Secrets key, inject it into `backstage-secrets`, and
push the updated SealedSecret to git:

```bash
ansible-playbook ansible/playbooks/post-install.yml \
  --vault-password-file ansible/vault_pass \
  -e ocp_api_url=<cluster-api> \
  -e ocp_username=admin \
  -e ocp_password=<password> \
  --tags metering-prometheus-token
```

After the playbook runs, trigger an ArgoCD sync and restart the RHDH pod
so it picks up the new `METERING_PROMETHEUS_TOKEN` environment variable:

```bash
oc patch application developer-hub-instance -n openshift-gitops \
  --type merge -p '{"operation":{"sync":{"revision":"HEAD"}}}'
oc rollout restart deployment/backstage-developer-hub -n developer-hub
```

#### Why `cluster-monitoring-view` and not `default` SA

Granting `cluster-monitoring-view` to the pod's `default` SA works but is
broad — any other workload in the namespace that mounts the `default` SA
token inherits Prometheus access. Using a dedicated SA scopes the privilege
to exactly the token that the metering plugin holds, following the
principle of least privilege.

## 7. Local development loop (`rhdh-local`)

Rebuilding an OCI image for every change is far too slow for iteration.
[`export-dev.sh`](./export-dev.sh) rebuilds TypeScript declarations and
runs `plugin export --dev` straight into a local
[rhdh-local](https://github.com/redhat-developer/rhdh-local) checkout:

```14:24:plugins/export-dev.sh
for plugin in metering-backend metering; do
  echo ""
  echo "==> Building type declarations for ${plugin}..."
  (cd "${SCRIPT_DIR}/${plugin}" && yarn build:types)

  echo "==> Exporting ${plugin} to ${LOCAL_PLUGINS}..."
  (cd "${SCRIPT_DIR}/${plugin}" && \
    npx @red-hat-developer-hub/cli@1.10 plugin export \
      --dev \
      --dynamic-plugins-root "${LOCAL_PLUGINS}" \
      --clean)
done
```

`rhdh-local/configs/dynamic-plugins/dynamic-plugins.override.yaml` then
points at those exported local paths instead of an OCI image.

### How rhdh-local storage works

Understanding the volume layout is essential to restart correctly:

```
rhdh-local/local-plugins/          ← bind mount; export-dev.sh writes here
         │
         │  (copied by install-dynamic-plugins init container)
         ▼
Podman named volume: rhdh-local_dynamic-plugins-root
         │
         │  (mounted read-only into the rhdh container)
         ▼
/opt/app-root/src/dynamic-plugins-root/   ← what RHDH reads
```

`export-dev.sh` only writes to `local-plugins/`. The named volume is a
**separate location** populated by the `install-dynamic-plugins` init
container. `podman stop rhdh && podman start rhdh` alone does **not**
re-run the init container and therefore does **not** sync new exports into
the volume.

### Correct restart procedure after `export-dev.sh`

```bash
# In rhdh-local/
cd ~/PersonalProject/rhdh-local

# 1. Run the init container to sync local-plugins/ → named volume
#    (wait for it to exit before continuing)
podman compose run --rm install-dynamic-plugins

# 2. Restart RHDH — now reads the freshly populated volume
podman stop rhdh && podman start rhdh
```

### Clean-slate restart (recommended when volume state is suspect)

If the volume has corrupted or stale state from a failed hot-reload:

```bash
podman compose down
podman volume rm rhdh-local_dynamic-plugins-root
podman compose up -d   # respects depends_on: install-dynamic-plugins completes first
```

`podman compose up` honours the `service_completed_successfully` dependency,
so RHDH only starts once the volume is fully populated — eliminating the
race conditions that occur when running init and main containers
concurrently.

## 8. Quick-start checklist for a new plugin

1. Confirm the target RHDH release's Backstage version; update
   `backstage.json` if it differs from what's already pinned.
2. `npx @backstage/create-app` or hand-scaffold a new package under
   `plugins/<name>/` with the right `backstage.role`, add it to the root
   `workspaces` array.
3. Pin every `@backstage/*` dependency to a version compatible with the
   pinned Backstage release (`npm view <pkg> versions`).
4. Write the feature code as plain, framework-agnostic modules
   (`router.ts`, `api.ts`, service classes...).
5. Wire them into `src/plugin.ts` via `createBackendPlugin`/
   `createFrontendPlugin` — keep this file thin.
6. Add a `config.schema.json` (if it takes config) and validate the same
   shape with Zod inside `init()`.
7. For frontend plugins, add the `scalprum` block and decide what to
   export by name for `mountPoints`/`importName`.
8. `yarn build:types && npx @red-hat-developer-hub/cli plugin export --dev`
   into a local `rhdh-local` checkout to test end-to-end before packaging
   an OCI image.
