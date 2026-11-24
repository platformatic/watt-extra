import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import semver from 'semver'
import { parseMemorySize } from '@platformatic/foundation'
import { RequestsCollector } from '../lib/requests-collector.js'

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
  let requestCountsListener = null

  let requestsCollector = null
  let pendingRequestCounts = {}
  let requestCountsFrom = Date.now()
  let isSendingRequestCounts = false

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

    let eluBatchThreshold = app.env.PLT_HEALTH_SIGNALS_ELU_BATCH_THRESHOLD
    if (eluBatchThreshold > eluThreshold) {
      eluBatchThreshold = eluThreshold
    }

    let heapThreshold = app.env.PLT_HEAP_HEALTH_SIGNAL_THRESHOLD
    if (typeof heapThreshold === 'string') {
      heapThreshold = parseMemorySize(heapThreshold)
    }

    let heapBatchThreshold = app.env.PLT_HEALTH_SIGNALS_HEAP_BATCH_THRESHOLD
    if (typeof heapBatchThreshold === 'string') {
      heapBatchThreshold = parseMemorySize(heapBatchThreshold)
    }

    heapThresholdMb = Math.round(heapThreshold / 1024 / 1024)

    let heapBatchThresholdMb = Math.round(heapBatchThreshold / 1024 / 1024)
    if (heapBatchThresholdMb > heapThresholdMb) {
      heapBatchThresholdMb = heapThresholdMb
    }

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
        value: Math.round(elu * 100) / 100,
        timestamp: now
      })
      signalsCache.addServiceSignal(serviceId, 'heap', {
        workerId,
        value: heapUsedMb,
        timestamp: now
      })
      heapTotalByService[serviceId] = heapTotal
      signalsCache.addServiceSignals(serviceId, healthSignals)

      if (elu > eluBatchThreshold || heapUsedMb > heapBatchThresholdMb) {
        batchHasHighValue = true
      }
    }
    runtime.on('application:worker:health:metrics', healthMetricsListener)

    // Before v4 the HTTP metrics reset on every read by default: each read is then the requests since
    // the previous one. Other readers (e.g. Prometheus) take requests away from both.
    if (requestsCollector === null) {
      const resetHttpMetrics = runtime.getRuntimeConfig(true).metrics?.resetHttpMetrics
      const isResetDisabled = resetHttpMetrics === false || resetHttpMetrics === 'false'
      const isHttpMetricsReset = semver.major(runtimeVersion) < 4 && !isResetDisabled
      requestsCollector = new RequestsCollector(isHttpMetricsReset)
    }

    if (requestCountsListener) {
      app.metrics.off('metrics', requestCountsListener)
    }
    requestCountsListener = async ({ metrics, workers, timestamp }) => {
      // ICC can change the label at runtime (updateMetricsConfig)
      const serviceLabel = runtime.getRuntimeConfig(true).metrics?.applicationLabel ?? 'serviceId'
      const requestCounts = requestsCollector.collect(metrics, workers, serviceLabel)
      addPendingRequestCounts(requestCounts)

      // A slow send must not be overtaken: the requests read meanwhile go with the next one
      if (isSendingRequestCounts) return
      isSendingRequestCounts = true
      try {
        await sendRequestCounts(timestamp)
      } finally {
        isSendingRequestCounts = false
      }
    }
    app.metrics.on('metrics', requestCountsListener)

    await sendReadyStatus()
  }
  app.setupHealthSignals = setupHealthSignals

  async function sendReadyStatus () {
    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const applicationId = app.instanceConfig?.applicationId
    const runtimeId = app.getRuntimeId()
    const timestamp = Date.now()
    const authHeaders = await app.getAuthorizationHeaders()

    const { statusCode, body } = await request(`${scalerUrl}/ready`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({ applicationId, runtimeId, timestamp })
    })

    if (statusCode !== 200) {
      const error = await body.text()
      app.log.error({ error }, 'Failed to send the instance ready status to scaler')
    }
  }

  function addPendingRequestCounts (requestCounts) {
    for (const [serviceId, requests] of Object.entries(requestCounts)) {
      const pendingRequests = pendingRequestCounts[serviceId] ?? 0
      pendingRequestCounts[serviceId] = pendingRequests + requests
    }
  }

  // Sends the requests per service received in [from, to]. `from` moves forward only when the scaler
  // acknowledges them: requests it did not acknowledge go with the next interval, from the same `from`.
  async function sendRequestCounts (requestCountsTo) {
    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const applicationId = app.instanceConfig?.applicationId
    const runtimeId = app.getRuntimeId()
    const entrypoint = app.watt.runtime.getRuntimeConfig(true).entrypoint ?? null
    const authHeaders = await app.getAuthorizationHeaders()

    const requestCounts = pendingRequestCounts
    pendingRequestCounts = {}

    let isFailed = true
    try {
      const { statusCode, body } = await request(`${scalerUrl}/request-counts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify({
          applicationId,
          runtimeId,
          entrypoint,
          from: requestCountsFrom,
          to: requestCountsTo,
          requests: requestCounts
        })
      })

      if (statusCode === 200) {
        await body.dump()
        isFailed = false
      } else {
        const error = await body.text()
        app.log.error({ error }, 'Failed to send request counts to scaler')
      }
    } finally {
      if (isFailed) {
        addPendingRequestCounts(requestCounts)
      }
    }

    if (!isFailed) {
      requestCountsFrom = requestCountsTo
    }
  }

  async function sendHealthSignals (rawSignals, batchStartedAt) {
    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const applicationId = app.instanceConfig?.applicationId
    const authHeaders = await app.getAuthorizationHeaders()

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
