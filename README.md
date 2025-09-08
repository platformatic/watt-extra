# Watt-Extra

Watt-Extra is an enterprise-ready runtime manager for Platformatic applications that provides production-grade capabilities including monitoring, compliance checking, caching, authentication, and integration with Infrastructure Control Center (ICC) services.

## Overview

Watt-Extra wraps existing Platformatic applications (Service, Composer, Node, or Next.js) to enhance them with enterprise features without requiring any code changes. It acts as a transparent layer that:

- **Monitors** application performance and health metrics
- **Enforces** compliance policies and security rules
- **Manages** HTTP caching strategies based on ICC configuration
- **Handles** authentication and authorization flows
- **Schedules** cron jobs and periodic tasks
- **Reports** metadata and telemetry to control plane services

The runtime manager dynamically patches Platformatic configurations at startup to inject these capabilities while maintaining full compatibility with your existing applications.

## Environment Variables

### Required

None.

### Optional

- `PLT_ICC_URL` - Infrastructure Control Center URL for connecting to control plane services. When not set, Watt-Extra runs in standalone mode without ICC integration
- `PLT_APP_NAME` - Unique identifier for your application instance. Optional when `PLT_ICC_URL` is set - if not provided, it will be automatically determined from Kubernetes labels following these rules:
  1. Uses `app.kubernetes.io/instance` label first
  2. Falls back to ReplicaSet naming convention (`{app-name}-{hash}`)
- `PLT_APP_DIR` - Application directory (defaults to current working directory)
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

Add a script to your package.json:

```json
"scripts": {
  "watt-extra": "watt-extra start"
}
```

Then run:

```bash
npm run watt-extra
```

### Command Line Interface

Watt-Extra provides a command-line interface:

```bash
# Show help
watt-extra --help

# Start the runtime manager
watt-extra start

# Set log level
watt-extra start --log-level=debug

# Set ICC URL
watt-extra start --icc-url=http://icc-server:3000

# Set application name
watt-extra start --app-name=my-application

# Set application directory. This is useful for development and test
watt-extra start --app-dir=/path/to/application
```
