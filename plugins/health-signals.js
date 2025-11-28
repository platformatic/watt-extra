import { request } from 'undici'
import semver from 'semver'
import { parseMemorySize } from '@platformatic/foundation'

class HealthSignalsCache {
  #signals = []
  #size = 100

  constructor () {
    this.#signals = []
  }

  add (signals) {
    for (const signal of signals) {
      this.#signals.push(signal)
    }
    if (this.#signals.length > this.#size) {
      this.#signals.splice(0, this.#signals.length - this.#size)
    }
  }

  getAll () {
    const values = this.#signals
    this.#signals = []
    return values
  }
}

async function healthSignals (app, _opts) {
  const signalsCaches = {}
  const servicesSendingStatuses = {}

  // TODO: needed to the UI compatibility
  // remove after depricating the Scaler v1 UI
  const servicesMetrics = {}

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

    const eluThreshold = app.env.PLT_ELU_HEALTH_SIGNAL_THRESHOLD

    let heapThreshold = app.env.PLT_HEAP_HEALTH_SIGNAL_THRESHOLD
    if (typeof heapThreshold === 'string') {
      heapThreshold = parseMemorySize(heapThreshold)
    }

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

    runtime.on('application:worker:health:metrics', async (healthInfo) => {
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

      if (elu > eluThreshold) {
        healthSignals.push({
          type: 'elu',
          value: currentHealth.elu,
          description:
            `The ${serviceId} has an ELU of ${(elu * 100).toFixed(2)} %, ` +
              `above the maximum allowed usage of ${(eluThreshold * 100).toFixed(2)} %`,
          timestamp: Date.now()
        })
      }

      if (heapThreshold && heapUsed > heapThreshold) {
        const usedHeapMb = Math.round(heapUsed / 1024 / 1024)
        const heapThresholdMb = Math.round(heapThreshold / 1024 / 1024)

        healthSignals.push({
          type: 'heapUsed',
          value: currentHealth.heapUsed,
          description:
            `The ${serviceId} is using ${usedHeapMb} MB of heap, ` +
              `above the maximum allowed usage of ${heapThresholdMb} MB`,
          timestamp: Date.now()
        })
      }

      // TODO: needed to the UI compatibility
      // remove after depricating the Scaler v1 UI
      servicesMetrics[serviceId] ??= { elu: 0, heapUsed: 0, heapTotal: 0 }
      const metrics = servicesMetrics[serviceId]
      if (elu > metrics.elu) {
        metrics.elu = elu
      }
      if (heapUsed > metrics.heapUsed) {
        metrics.heapUsed = heapUsed
        metrics.heapTotal = heapTotal
      }

      if (healthSignals.length > 0) {
        await sendHealthSignalsWithTimeout(serviceId, workerId, healthSignals)
      }
    })
  }
  app.setupHealthSignals = setupHealthSignals

  async function sendHealthSignalsWithTimeout (serviceId, workerId, signals) {
    signalsCaches[serviceId] ??= new HealthSignalsCache()
    servicesSendingStatuses[serviceId] ??= false

    const signalsCache = signalsCaches[serviceId]
    signalsCache.add(signals)

    if (!servicesSendingStatuses[serviceId]) {
      servicesSendingStatuses[serviceId] = true
      setTimeout(async () => {
        servicesSendingStatuses[serviceId] = false

        const metrics = servicesMetrics[serviceId]
        servicesMetrics[serviceId] = null

        try {
          const signals = signalsCache.getAll()
          await sendHealthSignals(serviceId, workerId, signals, metrics)
        } catch (err) {
          app.log.error({ err }, 'Failed to send health signals to scaler')
        }
      }, 5000).unref()
    }
  }

  async function sendHealthSignals (serviceId, workerId, signals, metrics) {
    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const applicationId = app.instanceConfig?.applicationId
    const authHeaders = await app.getAuthorizationHeader()

    const { statusCode, body } = await request(`${scalerUrl}/signals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        applicationId,
        serviceId,
        signals,
        elu: metrics.elu,
        heapUsed: metrics.heapUsed,
        heapTotal: metrics.heapTotal
      })
    })

    if (statusCode !== 200) {
      const error = await body.text()
      app.log.error({ error }, 'Failed to send health signals to scaler')
    }

    const response = await body.json()

    app.requestFlamegraphs({
      serviceIds: [serviceId],
      workerIds: [workerId],
      alertId: response.alertId
    }).catch(err => {
      app.log.error({ err }, 'Failed to send a flamegraph')
    })
  }
}

export default healthSignals
