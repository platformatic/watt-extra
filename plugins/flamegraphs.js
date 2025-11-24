'use strict'

import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'

async function flamegraphs (app, _opts) {
  const isFlamegraphsDisabled = app.env.PLT_DISABLE_FLAMEGRAPHS
  const flamegraphsIntervalSec = app.env.PLT_FLAMEGRAPHS_INTERVAL_SEC
  const flamegraphsELUThreshold = app.env.PLT_FLAMEGRAPHS_ELU_THRESHOLD
  const flamegraphsGracePeriod = app.env.PLT_FLAMEGRAPHS_GRACE_PERIOD
  const flamegraphsAttemptTimeout = app.env.PLT_FLAMEGRAPHS_ATTEMPT_TIMEOUT
  const flamegraphsCacheCleanupInterval = app.env.PLT_FLAMEGRAPHS_CACHE_CLEANUP_INTERVAL

  const durationMillis = parseInt(flamegraphsIntervalSec) * 1000
  const eluThreshold = parseFloat(flamegraphsELUThreshold)
  const gracePeriod = parseInt(flamegraphsGracePeriod)
  const attemptTimeout = Math.min(parseInt(flamegraphsAttemptTimeout), durationMillis)
  const maxAttempts = Math.ceil(durationMillis / attemptTimeout) + 1
  const cacheCleanupInterval = parseInt(flamegraphsCacheCleanupInterval)

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

    setInterval(cleanupFlamegraphsCache, cacheCleanupInterval).unref()
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

  const profilesByWorkerId = {}

  app.sendFlamegraphs = async (options = {}) => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, flamegraphs are disabled')
      return
    }

    let { workerIds, alertId, profileType = 'cpu' } = options

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    if (!scalerUrl) {
      app.log.error('No scaler URL found in ICC services, cannot send flamegraph')
      throw new Error('No scaler URL found in ICC services, cannot send flamegraph')
    }

    const runtime = app.watt.runtime

    if (!workerIds) {
      const { applications } = await runtime.getApplications()
      workerIds = applications.map(app => app.id)
    }

    cleanupFlamegraphsCache()

    const uploadPromises = workerIds.map(async (workerId) => {
      const serviceId = workerId.split(':')[0]
      const profileKey = `${workerId}:${profileType}`

      let profile = profilesByWorkerId[profileKey]
      if (profile !== undefined) {
        if (alertId) {
          app.log.info(
            { workerId, alertId }, 'Flamegraph will be attached to the alert'
          )
          profile.waitingAlerts.push(alertId)
        }

        if (profile.flamegraphId === null) {
          app.log.info({ workerId }, 'Waiting for flamegraph to be generated and sent')
          return
        }
      }

      if (profile === undefined) {
        profile = {
          type: profileType,
          data: null,
          timestamp: null,
          flamegraphId: null,
          waitingAlerts: []
        }
        profilesByWorkerId[profileKey] = profile

        const result = await getServiceFlamegraph(workerId, profileType)
        if (!result || !(result.data instanceof Uint8Array)) {
          app.log.error({ workerId }, 'Failed to get profile from service')
          delete profilesByWorkerId[profileKey]
          return
        }

        profile.data = result.data
        profile.timestamp = result.timestamp
      }

      if (profile.flamegraphId === null || !alertId) {
        try {
          const flamegraph = await sendServiceFlamegraph(
            scalerUrl,
            serviceId,
            profile.data,
            profileType,
            alertId
          )
          profile.flamegraphId = flamegraph.id
        } catch (err) {
          app.log.error({ err, workerId, alertId, profileType }, 'Failed to send flamegraph')
          delete profilesByWorkerId[profileKey]
          return
        }
      }

      const waitingAlerts = profile.waitingAlerts
      if (waitingAlerts.length > 0) {
        profile.waitingAlerts = []
        await _attachFlamegraphToAlerts(
          scalerUrl,
          serviceId,
          profile.flamegraphId,
          profile.data,
          profile.type,
          waitingAlerts
        )
      }
    })

    await Promise.all(uploadPromises)
  }

  async function getServiceFlamegraph (workerId, profileType, attempt = 1) {
    const runtime = app.watt.runtime

    app.log.info({ workerId, attempt, maxAttempts, attemptTimeout }, 'Getting profile from worker')

    try {
      const [state, profile] = await Promise.all([
        runtime.sendCommandToApplication(workerId, 'getProfilingState', { type: profileType }),
        runtime.sendCommandToApplication(workerId, 'getLastProfile', { type: profileType })
      ])
      return { data: profile, timestamp: state.latestProfileTimestamp }
    } catch (err) {
      if (err.code === 'PLT_PPROF_NO_PROFILE_AVAILABLE') {
        app.log.info(
          { workerId, attempt, maxAttempts, attemptTimeout },
          'No profile available for the service. Waiting for profiling to complete.'
        )
        if (attempt <= maxAttempts) {
          await sleep(attemptTimeout)
          return getServiceFlamegraph(workerId, profileType, attempt + 1)
        }
      } else if (err.code === 'PLT_PPROF_NOT_ENOUGH_ELU') {
        app.log.info({ workerId }, 'ELU low, CPU profiling not active')
      } else {
        app.log.warn({ err, workerId }, 'Failed to get profile from a worker')

        const [serviceId, workerIndex] = workerId.split(':')
        if (workerIndex) {
          app.log.warn('Worker not available, trying to get profile from another worker')
          return getServiceFlamegraph(serviceId, profileType)
        }
      }
    }
  }

  async function sendServiceFlamegraph (scalerUrl, serviceId, profile, profileType, alertId) {
    const podId = app.instanceId
    const url = `${scalerUrl}/pods/${podId}/services/${serviceId}/flamegraph`
    app.log.info({ serviceId, podId, profileType }, 'Sending flamegraph')

    const query = { profileType }
    if (alertId) {
      query.alertId = alertId
    }

    const authHeaders = await app.getAuthorizationHeader()
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

    const response = await body.json()
    return response
  }

  // Function that supports ICC that doesn't have attach flamegraph API
  // Remove it and use the attachFlamegraphToAlerts when ICC is updated
  async function _attachFlamegraphToAlerts (
    scalerUrl,
    serviceId,
    flamegraphId,
    profile,
    profileType,
    alertIds
  ) {
    try {
      await attachFlamegraphToAlerts(scalerUrl, flamegraphId, alertIds)
      return
    } catch (err) {
      if (err.code === 'PLT_ATTACH_FLAMEGRAPH_MULTIPLE_ALERTS_NOT_SUPPORTED') {
        app.log.warn(
          'Attaching flamegraph multiple alerts is not supported by the scaler.' +
            ' Please upgrade to the latest ICC version to use this feature.'
        )
      } else {
        app.log.error({ err, alertIds, flamegraphId }, 'Failed to attach flamegraph to alert')
      }
    }

    const promises = []
    for (const alertId of alertIds) {
      const promise = sendServiceFlamegraph(
        scalerUrl,
        serviceId,
        profile,
        profileType,
        alertId
      )
      promises.push(promise)
    }

    const results = await Promise.allSettled(promises)
    for (const result of results) {
      if (result.status === 'rejected') {
        app.log.error({ result }, 'Failed to attach flamegraph to alert')
      }
    }
  }

  async function attachFlamegraphToAlerts (scalerUrl, flamegraphId, alertIds) {
    const url = `${scalerUrl}/flamegraphs/${flamegraphId}/alerts`
    app.log.info({ flamegraphId, alerts: alertIds }, 'Attaching flamegraph to alerts')

    const authHeaders = await app.getAuthorizationHeader()
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({ alertIds })
    })

    if (statusCode !== 200) {
      const error = await body.text()
      if (statusCode === 404 && error.includes('Route POST')) {
        const err = new Error('Attaching flamegraph multiple alerts is not supported by the scaler')
        err.code = 'PLT_ATTACH_FLAMEGRAPH_MULTIPLE_ALERTS_NOT_SUPPORTED'
        throw err
      }

      throw new Error(`Failed to attach flamegraph to alerts: ${error}`)
    }
  }

  function cleanupFlamegraphsCache () {
    const now = Date.now()

    for (const profileKey of Object.keys(profilesByWorkerId)) {
      const timestamp = profilesByWorkerId[profileKey]?.timestamp
      if (timestamp && now - timestamp > durationMillis) {
        delete profilesByWorkerId[profileKey]
      }
    }
  }
}

export default flamegraphs
