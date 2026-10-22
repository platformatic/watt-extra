# Watt-Extra

Watt-Extra is a Watt 4 runtime extension providing monitoring, compliance checking, caching, authentication, and integration with Infrastructure Control Center (ICC) services.

## Overview

Watt-Extra integrates with Platformatic applications (Service, Gateway, Node, or Next.js) through Watt's extension hooks. It:

- **Monitors** application performance and health metrics
- **Enforces** compliance policies and security rules
- **Manages** HTTP caching strategies based on ICC configuration
- **Handles** authentication and authorization flows
- **Schedules** cron jobs and periodic tasks
- **Reports** metadata and telemetry to control plane services

The extension patches configuration at startup; Watt owns the runtime lifecycle. This version requires Watt 4 with runtime extension configuration hooks.

## Environment Variables

### Required

None.

### Optional

- `PLT_ICC_URL` - Infrastructure Control Center URL for connecting to control plane services. When not set, Watt-Extra runs in standalone mode without ICC integration
- `PLT_APP_NAME` - Unique identifier for your application instance. Optional when `PLT_ICC_URL` is set - if not provided, it will be automatically determined from Kubernetes labels following these rules:
  1. Uses `app.kubernetes.io/instance` label first
  2. Falls back to ReplicaSet naming convention (`{app-name}-{hash}`)
- `PLT_APP_DIR` - Set by the extension to the Watt project root
- `PLT_TEST_TOKEN` - JWT token for authentication in non-Kubernetes environments
- `PLT_LOG_LEVEL` - Logging level for the application
- `PLT_CACHE_CONFIG` - HTTP caching configuration

### Standalone Mode

Watt-Extra can run without connecting to an Infrastructure Control Center (ICC). When `PLT_ICC_URL` is not set:

- No ICC connection attempts are made
- All ICC-dependent plugins (alerts, compliance, metadata, scheduler) skip their operations
- The application runs with local configuration only

## Installation

```bash
npm install @platformatic/watt-extra
```

## Usage

With Watt 4 including
[platformatic/platformatic#5254](https://github.com/platformatic/platformatic/pull/5254),
start Watt normally and load the extension:

```js
import { createWattConfig } from 'wattpm'

export default createWattConfig({
  autoload: { path: 'web' },
  extensions: [{ path: 'npm:@platformatic/watt-extra' }]
})
```

The extension uses the existing `PLT_*` settings. Its `options.env` object can
override them for an individual runtime. `PLT_APP_DIR` is the Watt project root.
The configure hook obtains the initial ICC configuration; setup attaches to the
runtime owned by Watt. ICC synchronization and retries start on the `started`
event, and shutdown releases the extension resources without closing Watt itself.
Configuration-only loads do not leave authentication timers or connections open.

The entrypoint currently relies on configuration object identity retained by
PR #5254 (`getRuntimeConfig(true)`) to transfer private state from configure to
setup. It does not serialize credentials or live clients into extension options.

The extension loads `@platformatic/wattpm-pprof-capture` for worker profiling.
Listener-specific settings belong to capability
configuration: the extension applies proxy/HTTPS patches to listening Service,
Gateway and DB applications. Configure Next.js listener settings in the application.

Scheduler jobs are paused after application startup and on subsequent application
starts. This is best-effort coordination: PR #5254 does not provide an API to create
jobs already paused, so a local tick during startup is still possible.

Integration tests use the published Watt and Service `4.0.0-alpha.3` packages,
including configuration hooks, worker startup, ICC registration and shutdown:

```bash
node --test test/extension.test.js
```

## Running the tests

The integration suites exercise the published Watt 4 runtime and the extension,
including caching, compliance, metrics, alerts, profiling, scheduler commands and
shared context. Start Valkey for the HTTP and Next.js caching tests:

```bash
docker compose up -d --wait
pnpm test
```

The test command enables Node's module-mocking flag solely to observe the Avvio
plugin container in integration tests; the real Watt loader and extension hooks
run unchanged. Valkey listens on port `6390`.
