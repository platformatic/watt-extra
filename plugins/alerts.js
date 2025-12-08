import { request } from 'undici'

async function alerts (app, _opts) {
  const pauseEluThreshold = app.env.PLT_FLAMEGRAPHS_PAUSE_ELU_TRESHOLD
  const pauseTimeout = app.env.PLT_FLAMEGRAPHS_PAUSE_TIMEOUT

  const healthCache = [] // It's OK to have this in memory, this is per-pod.
  const podHealthWindow =
    app.instanceConfig?.scaler?.podHealthWindow || 60 * 1000
  const alertRetentionWindow =
    app.instanceConfig?.scaler?.alertRetentionWindow || 10 * 1000

  const lastServicesAlertTime = {}
  const workerStartTimes = new Map() // Track per-worker start times for grace period

  async function setupAlerts () {
    const scalerAlgorithmVersion = app.instanceConfig?.scaler?.version ?? 'v1'
    if (scalerAlgorithmVersion !== 'v1') {
      app.log.info({ scalerVersion: scalerAlgorithmVersion }, 'Skipping v1 alerts setup, scaler version is not v1')
      return
    }
    app.log.info('Setting up v1 scaler alerts')

    // Grace period during which alerts are suppressed per-worker.
    const gracePeriodMs = app.env.PLT_ALERTS_GRACE_PERIOD_SEC * 1000

    // Skip alerts setup if ICC is not configured
    if (!app.env.PLT_ICC_URL) {
      app.log.info('PLT_ICC_URL not set, skipping alerts setup')
      return
    }

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const runtime = app.watt.runtime

    if (!scalerUrl) {
      app.log.warn(
        'No scaler URL found in ICC services, health alerts disabled'
      )
      return
    }

    // Default start time for workers that started before the listener was registered
    const pluginStartTime = Date.now()

    // Listen for worker start events to track start times
    runtime.on('application:worker:started', (workerInfo) => {
      const workerId = workerInfo?.id
      if (workerId) {
        workerStartTimes.set(workerId, Date.now())
        app.log.debug({ workerId }, 'Worker started, tracking for grace period')
      }
    })

    const processHealthInfo = async (healthInfo) => {
      if (!healthInfo) {
        app.log.error('No health info received')
        return
      }

      const timestamp = Date.now()
      const workerId = healthInfo.id
      const serviceId = healthInfo.application
      const healthWithTimestamp = { ...healthInfo, timestamp, service: serviceId }
      delete healthWithTimestamp.healthConfig // we don't need to store this

      const elu = healthInfo.currentHealth.elu
      if (elu >= pauseEluThreshold) {
        app.pauseProfiling({ serviceId, timeout: pauseTimeout })
      }

      healthCache.push(healthWithTimestamp)

      const cutoffTime = timestamp - podHealthWindow
      const validIndex = healthCache.findIndex(
        (entry) => entry.timestamp >= cutoffTime
      )
      if (validIndex > 0) {
        healthCache.splice(0, validIndex)
      }

      // Skip sending alerts during worker's grace period.
      // Use plugin start time as default for workers that started before the listener.
      const workerStartTime = workerStartTimes.get(workerId) ?? pluginStartTime
      if (timestamp - workerStartTime < gracePeriodMs) {
        app.log.debug({ workerId }, 'Skipping alert during worker grace period')
        return
      }

      // healthInfo is an object with the following structure:
      // id: "service-1"
      // service: "service-1"
      // currentHealth: {
      //   "elu": 0.003816403352054066,
      //   "heapUsed": 76798040,
      //   "heapTotal": 99721216
      // }
      // unhealthy: false
      // healthConfig: {
      //   "enabled": true,
      //   "interval": 1000,
      //   "gracePeriod": 1000,
      //   "maxUnhealthyChecks": 10,
      //   "maxELU": 0.99,
      //   "maxHeapUsed": 0.99,
      //   "maxHeapTotal": 4294967296
      // }

      if (healthInfo.unhealthy) {
        const currentTime = Date.now()

        const serviceId = healthInfo.application
        healthInfo.service = serviceId // ICC expects "service" field
        const lastAlertTime = lastServicesAlertTime[serviceId]

        if (lastAlertTime && currentTime - lastAlertTime < alertRetentionWindow) {
          app.log.debug('Skipping alert, within retention window')
          return
        }

        lastServicesAlertTime[serviceId] = currentTime
        delete healthInfo.healthConfig

        const authHeaders = await app.getAuthorizationHeader()

        const { statusCode, body } = await request(`${scalerUrl}/alerts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          body: JSON.stringify({
            applicationId: app.instanceConfig?.applicationId,
            alert: healthInfo,
            healthHistory: healthCache
          })
        })

        if (statusCode !== 200) {
          const error = await body.text()
          app.log.error({ error }, 'Failed to send alert to scaler')
          return
        }

        const alert = await body.json()

        app.requestFlamegraphs({ serviceIds: [serviceId], alertId: alert.id })
          .catch(err => app.log.error({ err }, 'Failed to send a flamegraph'))
      }
    }

    if (app.watt.runtimeSupportsNewHealthMetrics()) {
      // Runtime >= 3.18.0: Listen to health:metrics
      runtime.on('application:worker:health:metrics', async (health) => {
        if (!health) {
          app.log.error('No health info received')
          return
        }

        const {
          id,
          application: serviceId,
          currentHealth
        } = health

        const { elu, heapUsed, heapTotal } = currentHealth
        const healthConfig = app.watt.getHealthConfig()

        const unhealthyELUThreshold = 0.85
        const maxHeapUsed = healthConfig?.maxHeapUsed ?? 0.99

        const memoryUsage = heapUsed / heapTotal
        const unhealthy = elu > unhealthyELUThreshold || memoryUsage > maxHeapUsed

        const healthInfo = {
          id,
          application: serviceId,
          currentHealth,
          unhealthy,
          healthConfig: healthConfig || {}
        }

        await processHealthInfo(healthInfo)
      })
    } else {
      // Runtime < 3.18.0:
      runtime.on('application:worker:health', processHealthInfo)
    }
  }
  app.setupAlerts = setupAlerts
}

export default alerts
