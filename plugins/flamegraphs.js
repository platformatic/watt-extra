'use strict'

import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'

async function flamegraphs (app, _opts) {
  const isFlamegraphsDisabled = app.env.PLT_DISABLE_FLAMEGRAPHS
  const flamegraphsIntervalSec = app.env.PLT_FLAMEGRAPHS_INTERVAL_SEC
  const flamegraphsELUThreshold = app.env.PLT_FLAMEGRAPHS_ELU_THRESHOLD
  const flamegraphsGracePeriod = app.env.PLT_FLAMEGRAPHS_GRACE_PERIOD
  const flamegraphsAttemptTimeout = app.env.PLT_FLAMEGRAPHS_ATTEMPT_TIMEOUT

  const durationMillis = parseInt(flamegraphsIntervalSec) * 1000
  const eluThreshold = parseFloat(flamegraphsELUThreshold)
  const gracePeriod = parseInt(flamegraphsGracePeriod)
  const attemptTimeout = Math.min(parseInt(flamegraphsAttemptTimeout), durationMillis)
  const maxAttempts = Math.ceil(durationMillis / attemptTimeout) + 1

  let workerStartedListener = null

  const startProfilingOnWorker = async (runtime, workerFullId, logContext = {}) => {
    await sleep(gracePeriod)

    // Get application details to read service-level sourceMaps setting
    const appDetails = await runtime.getApplicationDetails(workerFullId)
    const sourceMaps = appDetails.sourceMaps ?? false

    try {
      // Start CPU profiling
      await runtime.sendCommandToApplication(
        workerFullId,
        'startProfiling',
        { durationMillis, eluThreshold, type: 'cpu', sourceMaps }
      )

      // Start HEAP profiling
      await runtime.sendCommandToApplication(
        workerFullId,
        'startProfiling',
        { durationMillis, eluThreshold, type: 'heap', sourceMaps }
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

  app.cleanupFlamegraphs = async () => {
    if (workerStartedListener && app.watt?.runtime) {
      app.watt.runtime.removeListener('application:worker:started', workerStartedListener)
      workerStartedListener = null
    }

    // Explicitly stop all active profiling sessions to avoid memory corruption
    if (!isFlamegraphsDisabled && app.watt?.runtime) {
      try {
        const workers = await app.watt.runtime.getWorkers()
        const stopPromises = []
        for (const workerFullId of Object.keys(workers)) {
          // Stop both CPU and heap profiling on each worker
          stopPromises.push(
            app.watt.runtime.sendCommandToApplication(workerFullId, 'stopProfiling', { type: 'cpu' })
              .catch(err => {
                // Ignore errors if profiling wasn't running
                if (err.code !== 'PLT_PPROF_PROFILING_NOT_STARTED') {
                  app.log.warn({ err, workerFullId }, 'Failed to stop CPU profiling')
                }
              })
          )
          stopPromises.push(
            app.watt.runtime.sendCommandToApplication(workerFullId, 'stopProfiling', { type: 'heap' })
              .catch(err => {
                // Ignore errors if profiling wasn't running
                if (err.code !== 'PLT_PPROF_PROFILING_NOT_STARTED') {
                  app.log.warn({ err, workerFullId }, 'Failed to stop heap profiling')
                }
              })
          )
        }
        await Promise.all(stopPromises)
        // Small delay to ensure native cleanup completes
        await sleep(100)
      } catch (err) {
        app.log.warn({ err }, 'Failed to stop profiling during cleanup')
      }
    }
  }

  async function getServiceFlamegraph (serviceId, profileType, attempt = 1) {
    const runtime = app.watt.runtime

    try {
      const profile = await runtime.sendCommandToApplication(serviceId, 'getLastProfile', { type: profileType })
      return profile
    } catch (err) {
      if (err.code === 'PLT_PPROF_NO_PROFILE_AVAILABLE') {
        app.log.info(
          { serviceId, attempt, maxAttempts, attemptTimeout },
          'No profile available for the service. Waiting for profiling to complete.'
        )
        if (attempt <= maxAttempts) {
          await sleep(attemptTimeout)
          return getServiceFlamegraph(serviceId, profileType, attempt + 1)
        }
      } else if (err.code === 'PLT_PPROF_NOT_ENOUGH_ELU') {
        app.log.info({ serviceId }, 'ELU low, CPU profiling not active')
      } else {
        app.log.warn({ err, serviceId }, 'Failed to get profile from service')
      }
    }
  }

  app.sendFlamegraphs = async (options = {}) => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, flamegraphs are disabled')
      return
    }

    let { serviceIds, alertId, profileType = 'cpu' } = options

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
      const profile = await getServiceFlamegraph(serviceId, profileType)
      if (!profile || !(profile instanceof Uint8Array)) {
        app.log.error({ serviceId }, 'Failed to get profile from service')
        return
      }

      const url = `${scalerUrl}/pods/${podId}/services/${serviceId}/flamegraph`
      app.log.info({ serviceId, podId, profileType }, 'Sending flamegraph')

      const query = { profileType }
      if (alertId) {
        query.alertId = alertId
      }

      try {
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
        app.log.warn({ err, serviceId, podId }, 'Failed to send flamegraph from service')
      }
    })

    await Promise.all(uploadPromises)
  }
}

export default flamegraphs
