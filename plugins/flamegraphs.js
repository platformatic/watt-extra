'use strict'

import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'

async function flamegraphs (app, _opts) {
  const isFlamegraphsDisabled = app.env.PLT_DISABLE_FLAMEGRAPHS
  const flamegraphsIntervalSec = app.env.PLT_FLAMEGRAPHS_INTERVAL_SEC
  const flamegraphsELUThreshold = app.env.PLT_FLAMEGRAPHS_ELU_THRESHOLD
  const flamegraphsGracePeriod = app.env.PLT_FLAMEGRAPHS_GRACE_PERIOD

  const durationMillis = parseInt(flamegraphsIntervalSec) * 1000
  const eluThreshold = parseFloat(flamegraphsELUThreshold)
  const gracePeriod = parseInt(flamegraphsGracePeriod)

  let workerStartedListener = null

  const startProfilingOnWorker = async (runtime, workerFullId, logContext = {}) => {
    await sleep(gracePeriod)

    try {
      // Start CPU profiling
      await runtime.sendCommandToApplication(
        workerFullId,
        'startProfiling',
        { durationMillis, eluThreshold, type: 'cpu' }
      )

      // Start HEAP profiling
      await runtime.sendCommandToApplication(
        workerFullId,
        'startProfiling',
        { durationMillis, eluThreshold, type: 'heap' }
      )
    } catch (err) {
      app.log.error({ err, ...logContext }, 'Failed to start profiling')
      throw err
    }
  }

  app.setupFlamegraphs = async () => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, skipping profiling')
      return
    }

    app.log.info('Start profiling services')

    const runtime = app.watt.runtime
    const workers = await runtime.getWorkers()

    const promises = []
    for (const [workerFullId, workerInfo] of Object.entries(workers)) {
      if (workerInfo.status === 'started') {
        const promise = startProfilingOnWorker(runtime, workerFullId, { workerFullId })
        promises.push(promise)
      }
    }

    const results = await Promise.allSettled(promises)
    for (const result of results) {
      if (result.status === 'rejected') {
        app.log.error({ result }, 'Failed to start profiling')
      }
    }

    // Listen for new workers starting and start profiling on them
    workerStartedListener = ({ application, worker }) => {
      if (isFlamegraphsDisabled) {
        return
      }

      const workerFullId = [application, worker].join(':')
      app.log.info({ application, worker }, 'Starting profiling on new worker')

      startProfilingOnWorker(runtime, workerFullId, { application, worker }).catch(() => {
        // Error already logged in startProfilingOnWorker
      })
    }
    runtime.on('application:worker:started', workerStartedListener)
  }

  app.cleanupFlamegraphs = () => {
    if (workerStartedListener && app.watt?.runtime) {
      app.watt.runtime.removeListener('application:worker:started', workerStartedListener)
      workerStartedListener = null
    }
  }

  app.sendFlamegraphs = async (options = {}) => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, flamegraphs are disabled')
      return
    }

    let { serviceIds, alertId, type = 'cpu' } = options

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    if (!scalerUrl) {
      app.log.error('No scaler URL found in ICC services, cannot send flamegraph')
      throw new Error('No scaler URL found in ICC services, cannot send flamegraph')
    }

    const podId = app.instanceId
    const runtime = app.watt.runtime

    if (!serviceIds) {
      const { applications } = await runtime.getApplications()
      serviceIds = applications.map(app => app.id)
    }

    const authHeaders = await app.getAuthorizationHeader()

    const uploadPromises = serviceIds.map(async (serviceId) => {
      try {
        const profile = await runtime.sendCommandToApplication(serviceId, 'getLastProfile')
        if (!profile || !(profile instanceof Uint8Array)) {
          app.log.error({ serviceId }, 'Failed to get profile from service')
          return
        }

        const url = `${scalerUrl}/pods/${podId}/services/${serviceId}/flamegraph`

        app.log.info({ serviceId, podId, type }, 'Sending flamegraph')

        const query = { profileType: type }
        if (alertId) {
          query.alertId = alertId
        }

        const { statusCode, body } = await request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...authHeaders
          },
          query,
          body: profile
        })

        if (statusCode !== 200) {
          const error = await body.text()
          app.log.error({ error }, 'Failed to send flamegraph')
          throw new Error(`Failed to send flamegraph: ${error}`)
        }
      } catch (err) {
        if (err.code === 'PLT_PPROF_NO_PROFILE_AVAILABLE') {
          app.log.info({ serviceId, podId }, 'No profile available for the service')
        } else if (err.code === 'PLT_PPROF_NOT_ENOUGH_ELU') {
          app.log.info({ serviceId, podId }, 'ELU low, CPU profiling not active')
        } else {
          app.log.warn({ err, serviceId, podId }, 'Failed to send flamegraph from service')
        }
      }
    })

    await Promise.all(uploadPromises)
  }
}

export default flamegraphs
