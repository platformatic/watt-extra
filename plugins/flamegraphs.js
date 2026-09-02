'use strict'

import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'
import { ProfilingRuntimeNotAvailableError, ProfilingStatesSendError } from '../lib/errors.js'

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
  const stateReportInterval = parseInt(app.env.PLT_FLAMEGRAPHS_STATE_REPORT_INTERVAL ?? 30000)
  const stateQueryTimeout = parseInt(app.env.PLT_FLAMEGRAPHS_STATE_QUERY_TIMEOUT ?? 5000)

  const PROFILE_TYPES = ['cpu', 'heap']
  const kStateQueryTimeout = Symbol('kStateQueryTimeout')

  // Workers whose event loop did not answer a state query in time. The
  // timeout only bounds the report: the underlying ITC request cannot be
  // cancelled and stays pending in the runtime until the worker answers, so
  // querying a blocked worker on every interval would leak one pending
  // request per query. Further queries are suppressed with a bounded
  // backoff; the suppression is cleared when the worker restarts or answers.
  const STATE_QUERY_BACKOFF_MAX = 5 * 60 * 1000
  const unresponsiveWorkers = new Map()

  // Desired profiling state for this pod. It can be changed at runtime by the
  // start-profiling/stop-profiling ICC commands and it gates the
  // worker-started listener, so a deactivation survives worker restarts.
  // It does not survive a pod restart: a new pod boots with the default.
  // PLT_DISABLE_FLAMEGRAPHS only sets the boot default to off: ICC can still
  // activate profiling on this pod at runtime.
  const enabledTypes = new Set(isFlamegraphsDisabled ? [] : PROFILE_TYPES)

  let workerStartedListener = null
  let healthListener = null
  let stateReportTimer = null

  // Last observed event-loop utilization per worker, from the same health
  // events that drive the runtime's profiling ELU gate. It is attached to
  // the profiling state report so ICC can tell an idle pause (ELU below the
  // profiling threshold) from an overload pause (ELU above the cutoff): the
  // profiler state itself does not carry the pause reason. The field is
  // optional on both sides, so any watt-extra/ICC version mix keeps working.
  const ELU_SAMPLE_MAX_AGE = 60 * 1000
  const lastWorkerELU = new Map()

  function setupHealthTracking (runtime) {
    const healthEventName = app.watt.runtimeSupportsNewHealthMetrics?.()
      ? 'application:worker:health:metrics'
      : 'application:worker:health'

    // Remove the old listener if it exists (for ICC recovery scenario)
    if (healthListener) {
      runtime.removeListener(healthEventName, healthListener)
    }

    healthListener = (healthInfo) => {
      const workerId = healthInfo?.id
      const elu = healthInfo?.currentHealth?.elu
      if (workerId == null || typeof elu !== 'number') {
        return
      }
      lastWorkerELU.set(workerId, { elu, at: Date.now() })
    }
    runtime.on(healthEventName, healthListener)
  }
  // Set to false when the ICC scaler does not expose the profiling states
  // API (older ICC): reporting is disabled for the lifetime of the pod.
  let stateReportingSupported = true

  const startProfilingOnWorker = async (runtime, workerFullId, types, logContext = {}, { grace = true } = {}) => {
    if (grace) {
      await sleep(gracePeriod)
    }

    // Get application details to read service-level sourceMaps setting
    const appDetails = await runtime.getApplicationDetails(workerFullId)
    const sourceMaps = appDetails.sourceMaps ?? false

    for (const type of types) {
      try {
        await runtime.sendCommandToApplication(
          workerFullId,
          'startProfiling',
          { durationMillis, eluThreshold, type, sourceMaps }
        )
      } catch (err) {
        // A worker which is already being profiled is considered covered
        if (err.code === 'PLT_PPROF_PROFILING_ALREADY_STARTED') {
          continue
        }
        app.log.error({ err, type, ...logContext }, 'Failed to start profiling')
        throw err
      }
    }
  }

  const stopProfilingOnWorker = async (runtime, workerFullId, types, logContext = {}) => {
    for (const type of types) {
      try {
        await runtime.sendCommandToApplication(
          workerFullId,
          'stopProfiling',
          { type }
        )
      } catch (err) {
        // A worker which is not being profiled is already in the target state
        if (err.code === 'PLT_PPROF_PROFILING_NOT_STARTED') {
          continue
        }
        app.log.warn({ err, type, ...logContext }, 'Failed to stop profiling')
        throw err
      }
    }
  }

  app.setupFlamegraphs = async () => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, profiling starts deactivated on this pod')
    } else {
      app.log.info('Start profiling services')
    }

    const runtime = app.watt.runtime

    // Respect the runtime toggle on an ICC recovery re-setup: an operator
    // who deactivated profiling on this pod must not get it back silently.
    if (enabledTypes.size > 0) {
      const workers = await runtime.getWorkers()

      const promises = []
      for (const [workerFullId, workerInfo] of Object.entries(workers)) {
        if (workerInfo.status === 'started') {
          const promise = startProfilingOnWorker(runtime, workerFullId, [...enabledTypes], { workerFullId })
          promises.push(promise)
        }
      }

      const results = await Promise.allSettled(promises)
      for (const result of results) {
        if (result.status === 'rejected') {
          app.log.error({ result }, 'Failed to start profiling')
        }
      }
    }

    setupHealthTracking(runtime)

    // Remove old listener if it exists (for ICC recovery scenario)
    if (workerStartedListener) {
      runtime.removeListener('application:worker:started', workerStartedListener)
    }

    // Listen for new workers starting and start profiling on them
    workerStartedListener = ({ application, worker }) => {
      const workerFullId = [application, worker].join(':')

      // A restarted worker has a fresh event loop: query its state again
      unresponsiveWorkers.delete(workerFullId)

      if (enabledTypes.size === 0) {
        return
      }
      app.log.info({ application, worker }, 'Starting profiling on new worker')

      startProfilingOnWorker(runtime, workerFullId, [...enabledTypes], { application, worker }).catch(() => {
        // Error already logged in startProfilingOnWorker
      })
    }
    runtime.on('application:worker:started', workerStartedListener)

    setInterval(cleanupFlamegraphsCache, cacheCleanupInterval).unref()

    if (stateReportTimer === null) {
      stateReportTimer = setInterval(() => {
        reportProfilingStates().catch((err) => {
          app.log.error({ err }, 'Failed to report profiling states')
        })
      }, stateReportInterval)
      stateReportTimer.unref()
    }

    reportProfilingStates().catch((err) => {
      app.log.error({ err }, 'Failed to report profiling states')
    })
  }

  app.cleanupFlamegraphs = async () => {
    if (workerStartedListener && app.watt?.runtime) {
      app.watt.runtime.removeListener('application:worker:started', workerStartedListener)
      workerStartedListener = null
    }

    if (stateReportTimer) {
      clearInterval(stateReportTimer)
      stateReportTimer = null
    }

    if (healthListener && app.watt?.runtime) {
      const healthEventName = app.watt.runtimeSupportsNewHealthMetrics?.()
        ? 'application:worker:health:metrics'
        : 'application:worker:health'
      app.watt.runtime.removeListener(healthEventName, healthListener)
      healthListener = null
    }
    lastWorkerELU.clear()

    // Explicitly stop all active profiling sessions to avoid memory
    // corruption. Profiling may be active even when PLT_DISABLE_FLAMEGRAPHS
    // is set (runtime activation), so always attempt the stop: it is
    // idempotent.
    if (app.watt?.runtime) {
      try {
        const workers = await app.watt.runtime.getWorkers()
        const stopPromises = []
        for (const workerFullId of Object.keys(workers)) {
          // Stop both CPU and heap profiling on each worker
          stopPromises.push(
            stopProfilingOnWorker(app.watt.runtime, workerFullId, PROFILE_TYPES, { workerFullId })
              .catch(() => {
                // Error already logged in stopProfilingOnWorker
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

  // Activates or deactivates continuous profiling on this pod at runtime,
  // driven by the start-profiling/stop-profiling ICC commands. It also works
  // on a pod started with PLT_DISABLE_FLAMEGRAPHS: the variable only sets
  // the boot default, the commands override it for this pod's lifetime.
  app.setProfilingEnabled = async (enabled, types = PROFILE_TYPES) => {
    if (isFlamegraphsDisabled && enabled) {
      app.log.info('Activating profiling on a pod started with PLT_DISABLE_FLAMEGRAPHS')
    }

    const runtime = app.watt?.runtime
    if (!runtime) {
      throw new ProfilingRuntimeNotAvailableError()
    }

    const validTypes = types.filter((type) => PROFILE_TYPES.includes(type))
    for (const type of validTypes) {
      if (enabled) {
        enabledTypes.add(type)
      } else {
        enabledTypes.delete(type)
      }
    }

    const workers = await runtime.getWorkers()
    const promises = []
    for (const [workerFullId, workerInfo] of Object.entries(workers)) {
      if (workerInfo.status !== 'started') {
        continue
      }
      const promise = enabled
        ? startProfilingOnWorker(runtime, workerFullId, validTypes, { workerFullId }, { grace: false })
        : stopProfilingOnWorker(runtime, workerFullId, validTypes, { workerFullId })
      promises.push(promise)
    }

    const results = await Promise.allSettled(promises)
    let failures = 0
    for (const result of results) {
      if (result.status === 'rejected') {
        failures++
        app.log.error({ result, enabled }, 'Failed to toggle profiling on a worker')
      }
    }

    app.log.info({ enabled, types: validTypes, failures }, 'Profiling toggled')

    // Report the new state right away so the UI converges quickly. The
    // report carries the real per-worker profiler state (isCapturing), so a
    // worker which failed to toggle is reconciled by ICC from that, not from
    // the enabledTypes intent.
    reportProfilingStates().catch((err) => {
      app.log.error({ err }, 'Failed to report profiling states')
    })

    return { success: failures === 0, enabled, types: [...enabledTypes], failures }
  }

  const profilesByWorkerId = {}

  app.sendFlamegraphs = async (options = {}) => {
    let { workerIds, alertId, profileType = 'cpu' } = options

    // The runtime toggle is the single gate: profiling may be deactivated on
    // a pod booted with it on, or activated on a pod booted with
    // PLT_DISABLE_FLAMEGRAPHS
    if (!enabledTypes.has(profileType)) {
      app.log.warn(
        { profileType },
        'Profiling is deactivated on this pod, cannot collect the profile'
      )
      return
    }

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

    // The runtime may have been closed while waiting between attempts
    if (!runtime) {
      app.log.warn({ workerId }, 'Runtime not available, cannot get profile')
      return
    }

    app.log.info({ workerId, attempt, maxAttempts, attemptTimeout }, 'Getting profile from worker')

    try {
      const { profile, timestamp, preserved } = await runtime.getApplicationLastProfile(
        workerId,
        { type: profileType }
      )
      app.log.info({ workerId, profileType, preserved }, 'Got profile from worker')
      return { data: profile, timestamp }
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
      } else if (err.code === 'PLT_RUNTIME_LAST_PROFILE_TIMEOUT') {
        // The runtime throws this when the worker event loop is unresponsive
        // (e.g. saturated by high ELU or hard-blocked) and no preserved
        // overload profile has been captured yet
        app.log.warn(
          { workerId },
          'Worker event loop is not responding, likely saturated (ELU too high), ' +
            'and no preserved overload profile is available yet'
        )
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

    const authHeaders = await app.getAuthorizationHeaders()
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

    const authHeaders = await app.getAuthorizationHeaders()
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

  // Collects the real profiling state of every worker and reports it to the
  // scaler together with the pod's desired state. The report expires in
  // Valkey, so a pod which stops reporting naturally disappears from the UI.
  //
  // Concurrent invocations are coalesced: while a report is running, a new
  // request queues at most one re-run after it, so a slow scaler or a
  // blocked worker cannot pile up overlapping reports.
  let reportInFlight = null
  let reportQueued = false

  app.reportProfilingStates = reportProfilingStates
  function reportProfilingStates () {
    if (reportInFlight) {
      reportQueued = true
      return reportInFlight
    }

    reportInFlight = collectAndSendProfilingStates().finally(() => {
      reportInFlight = null
      if (reportQueued) {
        reportQueued = false
        reportProfilingStates().catch((err) => {
          app.log.error({ err }, 'Failed to report profiling states')
        })
      }
    })
    return reportInFlight
  }

  async function collectAndSendProfilingStates () {
    if (!stateReportingSupported) {
      return
    }

    const runtime = app.watt?.runtime
    if (!runtime) {
      return
    }

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    const applicationId = app.instanceConfig?.applicationId
    if (!scalerUrl || !applicationId) {
      return
    }

    const workers = await runtime.getWorkers()

    // One blocked worker must not prevent the others from being reported:
    // the queries run in parallel and each is bounded by a timeout
    const queries = []
    for (const [workerFullId, workerInfo] of Object.entries(workers)) {
      if (workerInfo.status !== 'started') {
        continue
      }

      const serviceId = workerFullId.split(':')[0]

      // A suppressed worker is still part of the report: an explicit
      // unresponsive entry keeps ICC from treating the remaining healthy
      // workers as the whole pod
      const suppression = unresponsiveWorkers.get(workerFullId)
      if (suppression && Date.now() < suppression.skipUntil) {
        app.log.debug({ workerFullId }, 'Skipping the state query of an unresponsive worker')
        for (const type of PROFILE_TYPES) {
          queries.push(Promise.resolve(unresponsiveState(workerFullId, serviceId, type)))
        }
        continue
      }

      for (const type of PROFILE_TYPES) {
        queries.push(getWorkerProfilingState(runtime, workerFullId, serviceId, type))
      }
    }

    const states = await Promise.all(queries)

    await sendProfilingStates(scalerUrl, applicationId, states)
  }

  // A worker whose profiling state cannot be read still appears in the
  // report: ICC must know the state is unknown rather than assume the
  // reported workers are the whole pod
  function unresponsiveState (workerFullId, serviceId, type) {
    return {
      serviceId,
      workerId: workerFullId,
      type,
      enabled: enabledTypes.has(type),
      unresponsive: true
    }
  }

  // Queries one worker for its profiling state of one type. Reports the
  // worker as unresponsive when it cannot answer: the query has no timeout
  // of its own and hangs if the worker event loop is blocked, which is
  // likely exactly when profiling is in use, so it is bounded here.
  async function getWorkerProfilingState (runtime, workerFullId, serviceId, type) {
    let state = null
    try {
      const query = runtime.sendCommandToApplication(
        workerFullId,
        'getProfilingState',
        { type }
      )
      // A settlement after the timeout must not surface as an unhandled
      // rejection
      query.catch(() => {})

      state = await Promise.race([
        query,
        sleep(stateQueryTimeout, kStateQueryTimeout, { ref: false })
      ])

      if (state === kStateQueryTimeout) {
        // Both types of the same worker time out together: escalate the
        // backoff only once per cycle
        const existing = unresponsiveWorkers.get(workerFullId)
        if (!existing || Date.now() >= existing.skipUntil) {
          const backoff = Math.min(
            existing ? existing.backoff * 2 : stateReportInterval,
            STATE_QUERY_BACKOFF_MAX
          )
          unresponsiveWorkers.set(workerFullId, { skipUntil: Date.now() + backoff, backoff })
        }
        app.log.warn(
          { workerFullId, type, stateQueryTimeout },
          'Timed out getting the profiling state from a worker, suppressing its state queries'
        )
        return unresponsiveState(workerFullId, serviceId, type)
      }

      unresponsiveWorkers.delete(workerFullId)
    } catch (err) {
      app.log.warn({ err, workerFullId, type }, 'Failed to get profiling state from worker')
      return unresponsiveState(workerFullId, serviceId, type)
    }

    // A runtime without the pprof capture command answers with an
    // empty object
    if (!state || state.isCapturing === undefined) {
      return {
        serviceId,
        workerId: workerFullId,
        type,
        enabled: enabledTypes.has(type),
        unsupported: true
      }
    }

    const entry = {
      serviceId,
      workerId: workerFullId,
      type,
      enabled: enabledTypes.has(type),
      ...state
    }

    const eluSample = lastWorkerELU.get(workerFullId) ?? lastWorkerELU.get(serviceId)
    if (eluSample && Date.now() - eluSample.at <= ELU_SAMPLE_MAX_AGE) {
      entry.lastELU = eluSample.elu
    }

    return entry
  }

  async function sendProfilingStates (scalerUrl, applicationId, states) {
    const podId = app.instanceId
    const url = `${scalerUrl}/flamegraphs/states`

    const authHeaders = await app.getAuthorizationHeaders()
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        applicationId,
        podId,
        // Three report intervals, so one missed report does not blank the UI
        expiresIn: stateReportInterval * 3,
        states
      })
    })

    if (statusCode === 404) {
      // An ICC without the profiling states API: disable reporting for the
      // lifetime of this pod
      await body.dump()
      stateReportingSupported = false
      if (stateReportTimer) {
        clearInterval(stateReportTimer)
        stateReportTimer = null
      }
      app.log.warn(
        'The scaler does not support profiling state reports.' +
          ' Please upgrade to the latest ICC version to use this feature.'
      )
      return
    }

    if (statusCode !== 200) {
      const error = await body.text()
      throw new ProfilingStatesSendError(error)
    }

    await body.dump()
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
