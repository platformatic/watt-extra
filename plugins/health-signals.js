import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import semver from 'semver'
import { parseMemorySize } from '@platformatic/foundation'

class HealthSignalsCache {
  #signalsByService = {}
  #maxSize = 500

  addServiceSignals (serviceId, signals) {
    for (const signal of signals) {
      this.addServiceSignal(serviceId, signal.type, signal)
    }
  }

  addServiceSignal (serviceId, signalType, signal) {
    const { workerId, value, timestamp } = signal
    this.#signalsByService[serviceId] ??= {}
    this.#signalsByService[serviceId][signalType] ??= {}
    this.#signalsByService[serviceId][signalType][workerId] ??= []

    const values = this.#signalsByService[serviceId][signalType][workerId]
    values.push([timestamp, value])

    if (values.length > this.#maxSize) {
      values.splice(0, values.length - this.#maxSize)
    }
  }

  getAllSignals () {
    const signalsByService = this.#signalsByService
    this.#signalsByService = {}
    return signalsByService
  }
}

async function healthSignals (app, _opts) {
  app.getRuntimeId = () => {
    if (!app.runtimeId) {
      app.runtimeId = randomUUID()
    }
    return app.runtimeId
  }

  const signalsCache = new HealthSignalsCache()
  const heapTotalByService = {}

  // Store listener reference for cleanup
  let healthMetricsListener = null

  // Store thresholds for use in sendHealthSignals
  let eluThreshold = null
  let heapThresholdMb = null

  async function setupHealthSignals () {
    const scalerAlgorithmVersion = app.instanceConfig?.scaler?.version ?? 'v1'
    if (scalerAlgorithmVersion !== 'v2') {
      app.log.info({ scalerVersion: scalerAlgorithmVersion }, 'Skipping v2 health signals setup, scaler version is not v2')
      return
    }
    app.log.info('Setting up v2 scaler health signals')

    const runtimeVersion = app.watt.getRuntimeVersion()
    if (semver.lt(runtimeVersion, '1.4.0')) {
      app.log.warn(
        `Watt version "${runtimeVersion}" does not support health signals for the Signal Scaler Algorithm.` +
          'Please update your watt-extra to version 1.4.0 or higher.'
      )
      return
    }

    // Skip alerts setup if ICC is not configured
    if (!app.env.PLT_ICC_URL) {
      app.log.info('PLT_ICC_URL not set, skipping alerts setup')
      return
    }

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    if (!scalerUrl) {
      app.log.warn(
        'No scaler URL found in ICC services, health alerts disabled'
      )
      return
    }

    const runtime = app.watt.runtime
    const batchShortTimeout = app.env.PLT_HEALTH_SIGNALS_SHORT_BATCH_TIMEOUT
    const batchLongTimeout = app.env.PLT_HEALTH_SIGNALS_LONG_BATCH_TIMEOUT
    eluThreshold = app.env.PLT_ELU_HEALTH_SIGNAL_THRESHOLD

    // TODO: get the used heap and use the 0.8 by default as a threshold
    let heapThreshold = app.env.PLT_HEAP_HEALTH_SIGNAL_THRESHOLD
    if (typeof heapThreshold === 'string') {
      heapThreshold = parseMemorySize(heapThreshold)
    }
    heapThresholdMb = Math.round(heapThreshold / 1024 / 1024)

    let batchHasHighValue = false
    let batchStartedAt = null

    setInterval(() => {
      if (batchStartedAt === null) return

      const now = Date.now()
      const batchTimeout = batchHasHighValue
        ? batchShortTimeout
        : batchLongTimeout

      if (now - batchStartedAt >= batchTimeout) {
        batchHasHighValue = false

        const signals = signalsCache.getAllSignals()

        sendHealthSignals(signals, batchStartedAt).catch(err => {
          app.log.error({ err }, 'Failed to send health signals to scaler')
        })

        batchStartedAt = Date.now()
      }
    }, 1000).unref()

    // Remove old listener if it exists (for ICC recovery scenario)
    if (healthMetricsListener) {
      runtime.removeListener('application:worker:health:metrics', healthMetricsListener)
    }

    healthMetricsListener = async (healthInfo) => {
      if (!healthInfo) {
        app.log.error('No health metrics info received')
      }

      const {
        id: workerId,
        application: serviceId,
        currentHealth,
        healthSignals
      } = healthInfo

      const { elu, heapUsed, heapTotal } = currentHealth
      const heapUsedMb = Math.round(heapUsed / 1024 / 1024)
      const now = Date.now()

      if (batchStartedAt === null) {
        batchStartedAt = now
      }

      signalsCache.addServiceSignal(serviceId, 'elu', {
        workerId,
        value: elu,
        timestamp: now
      })
      signalsCache.addServiceSignal(serviceId, 'heap', {
        workerId,
        value: heapUsedMb,
        timestamp: now
      })
      heapTotalByService[serviceId] = heapTotal
      signalsCache.addServiceSignals(serviceId, healthSignals)

      if (elu > eluThreshold || heapUsedMb > heapThresholdMb) {
        batchHasHighValue = true
      }
    }
    runtime.on('application:worker:health:metrics', healthMetricsListener)
  }
  app.setupHealthSignals = setupHealthSignals

  async function sendHealthSignals (rawSignals, batchStartedAt) {
    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const applicationId = app.instanceConfig?.applicationId
    const authHeaders = await app.getAuthorizationHeader()

    // Transform signals to the format expected by ICC LoadPredictor
    // Format: { serviceId: { elu: { options, workers: { workerId: { values: [[ts, val], ...] } } } } }
    const signals = {}
    for (const [serviceId, serviceSignals] of Object.entries(rawSignals)) {
      const eluWorkerMetrics = {}
      const heapWorkerMetrics = {}

      for (const [workerId, values] of Object.entries(serviceSignals.elu || {})) {
        eluWorkerMetrics[workerId] = { values }
      }
      for (const [workerId, values] of Object.entries(serviceSignals.heap || {})) {
        heapWorkerMetrics[workerId] = { values }
      }

      signals[serviceId] = {
        elu: {
          options: { threshold: eluThreshold },
          workers: eluWorkerMetrics
        },
        heap: {
          options: {
            threshold: heapThresholdMb,
            heapTotal: heapTotalByService[serviceId] || 0
          },
          workers: heapWorkerMetrics
        }
      }
    }

    const runtimeId = app.getRuntimeId()

    const { statusCode, body } = await request(`${scalerUrl}/signals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({ applicationId, runtimeId, signals, batchStartedAt })
    })

    if (statusCode !== 200) {
      const error = await body.text()
      app.log.error({ error }, 'Failed to send health signals to scaler')
      return
    }

    const { alerts = [] } = await body.json()
    const promises = []

    for (const alert of alerts) {
      const { serviceId, workerId, alertId } = alert
      const promise = app.sendFlamegraphs({
        serviceIds: [serviceId],
        workerIds: [workerId],
        alertId
      })
      promises.push(promise)
    }
    const results = await Promise.allSettled(promises)

    for (const result of results) {
      if (result.status === 'rejected') {
        app.log.error({ err: result.reason }, 'Failed to send a flamegraph')
      }
    }
  }
}

export default healthSignals
