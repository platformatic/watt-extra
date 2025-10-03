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

## Vertical Scaler

### Overview

The Vertical Scaler is an automatic resource allocation algorithm that dynamically adjusts the number of workers for applications based on their Event Loop Utilization (ELU) metrics. It intelligently balances computational resources across multiple applications while respecting system constraints.

### How It Works

#### Event Loop Utilization (ELU)

The algorithm uses ELU as its primary health metric. ELU measures how busy the Node.js event loop is:
- **0.0** = Event loop is completely idle
- **1.0** = Event loop is fully saturated

ELU values are collected continuously from all workers and averaged over a configurable time window to smooth out temporary spikes and make stable scaling decisions.

#### Scaling Logic

The algorithm operates in cycles, analyzing all applications and generating scaling recommendations:

**1. Metric Collection**
- Collects ELU metrics from all active workers
- Maintains a rolling time window of metrics (default: 60 seconds)
- Calculates average ELU per application across all its workers

**2. Application Prioritization**

Applications are prioritized based on:
- Primary: ELU value (lower ELU = higher priority for scaling down)
- Secondary: Worker count (more workers = higher priority for scaling down when ELU is equal)

**3. Scaling Decisions**

The algorithm makes decisions in this order:

**Scale Down (Low Utilization)**
- Any application with ELU below the scale-down threshold is reduced by 1 worker
- Applications must have at least 2 workers to be scaled down (minimum is always 1 worker)
- Multiple applications can scale down in the same cycle

**Scale Up (High Utilization)**
- The application with the highest ELU is checked against the scale-up threshold
- If above threshold, it receives 1 additional worker

**Resource Reallocation**

When the maximum worker limit is reached:
- The algorithm can transfer workers from low-utilization apps to high-utilization apps
- Transfer occurs when:
  - The high-ELU app needs scaling (ELU > scale-up threshold)
  - A low-ELU app has >1 worker available
  - Either:
    - ELU difference ≥ minimum ELU difference threshold, OR
    - Worker count difference ≥ 2
- One worker is removed from the lowest-ELU app and added to the highest-ELU app

#### Cooldown Period

After each scaling operation, the algorithm enters a cooldown period to prevent rapid oscillations. No scaling decisions are executed during cooldown, even if triggers occur.

### Configuration

#### Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| **maxWorkers** | Maximum total workers across all applications | Number of CPU cores |
| **scaleUpELU** | ELU threshold to trigger scaling up | 0.8 |
| **scaleDownELU** | ELU threshold to trigger scaling down | 0.2 |
| **minELUDiff** | Minimum ELU difference required for worker reallocation | 0.2 |
| **timeWindowSec** | Time window for averaging ELU metrics (seconds) | 60 |
| **cooldown** | Cooldown period between scaling operations (seconds) | - |
| **timeout** | Interval for periodic scaling checks (seconds) | - |

#### Environment Variables

```bash
PLT_MAX_WORKERS=10
PLT_VERTICAL_SCALER_SCALE_UP_ELU=0.8
PLT_VERTICAL_SCALER_SCALE_DOWN_ELU=0.2
PLT_VERTICAL_SCALER_METRICS_TIME_WINDOW_SEC=60
PLT_VERTICAL_SCALER_COOLDOWN_SEC=30
PLT_VERTICAL_SCALER_TIMEOUT_SEC=60
```

### Behavior Examples

#### Example 1: Scale Up (Under Limit)

**Initial State:**
- App A: 2 workers, ELU = 0.85
- App B: 1 worker, ELU = 0.3
- Total: 3 workers, Max: 10

**Decision:** Scale up App A to 3 workers (total under max limit)

**Result:**
- App A: 3 workers
- App B: 1 worker

---

#### Example 2: Worker Reallocation (At Limit)

**Initial State:**
- App A: 2 workers, ELU = 0.9
- App B: 2 workers, ELU = 0.15
- Total: 4 workers, Max: 4

**Analysis:**
- App A needs scaling (ELU = 0.9 > 0.8)
- At max worker limit
- ELU difference = 0.75 (exceeds minELUDiff of 0.2)

**Decision:** Transfer 1 worker from App B to App A

**Result:**
- App A: 3 workers
- App B: 1 worker

---

#### Example 3: Scale Down Only

**Initial State:**
- App A: 2 workers, ELU = 0.5
- App B: 3 workers, ELU = 0.1
- Total: 5 workers, Max: 10

**Decision:** Scale down App B to 2 workers (ELU below threshold)

**Result:**
- App A: 2 workers (unchanged)
- App B: 2 workers

---

#### Example 4: Multiple Scale Downs

**Initial State:**
- App A: 3 workers, ELU = 0.15
- App B: 2 workers, ELU = 0.18
- App C: 2 workers, ELU = 0.6

**Decision:** Scale down both App A and App B

**Result:**
- App A: 2 workers
- App B: 1 worker
- App C: 2 workers

---

#### Example 5: No Action (Insufficient Difference)

**Initial State:**
- App A: 3 workers, ELU = 0.85
- App B: 3 workers, ELU = 0.7
- Total: 6 workers, Max: 6

**Analysis:**
- App A needs scaling (ELU = 0.85 > 0.8)
- At max worker limit
- ELU difference = 0.15 (below minELUDiff of 0.2)
- Worker difference = 0 (below minimum of 2)

**Decision:** No scaling (conditions not met for reallocation)

