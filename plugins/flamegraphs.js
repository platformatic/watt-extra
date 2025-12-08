'use strict'

import { request } from 'undici'

export class Profiler {
  #workerId
  #type
  #duration
  #profileOptions
  #runtime
  #log
  #requests
  #isProfiling
  #onProfile
  #getProfileInterval
  #stopProfileTimeout
  #nextProfileTimestamp

  constructor (options = {}) {
    const { type, duration, workerId, sourceMaps, app, onProfile } = options

    if (type !== 'cpu' && type !== 'heap') {
      throw new Error('Invalid Profiler type. Must be either "cpu" or "heap"')
    }
    if (typeof duration !== 'number') {
      throw new Error('Invalid Profiler duration. Must be a number')
    }
    if (typeof workerId !== 'string') {
      throw new Error('Invalid Worker ID. Must be a string')
    }
    if (!workerId.includes(':')) {
      throw new Error('Worker ID must include the service ID and worker index')
    }
    if (typeof onProfile !== 'function') {
      throw new Error('Invalid onProfile handler. Must be a function')
    }

    this.#type = type
    this.#duration = duration
    this.#workerId = workerId
    this.#onProfile = onProfile

    this.#profileOptions = {
      type,
      durationMillis: duration,
      sourceMaps: sourceMaps ?? false
    }

    this.#requests = []
    this.#isProfiling = false

    this.#runtime = app.watt.runtime
    this.#log = app.log.child({
      workerId: this.#workerId,
      profilerType: this.#type
    })
  }

  get workerId () {
    return this.#workerId
  }

  get isProfiling () {
    return this.#isProfiling
  }

  get nextProfileTimestamp () {
    if (this.#requests.length === 0) {
      return null
    }
    return this.#nextProfileTimestamp ?? null
  }

  async requestProfile (request = {}) {
    request.timestamp ??= Date.now()
    this.#requests.push(request)
    this.#unscheduleStopProfiling()

    if (!this.#isProfiling) {
      this.#startProfilingLoop()
    }
  }

  async stop () {
    if (this.#getProfileInterval) {
      clearInterval(this.#getProfileInterval)
      this.#getProfileInterval = null
    }
    if (this.#stopProfileTimeout) {
      clearTimeout(this.#stopProfileTimeout)
      this.#stopProfileTimeout = null
    }

    this.#nextProfileTimestamp = null

    if (this.#isProfiling) {
      const requests = this.#getProfileRequests()
      try {
        const profile = await this.#stopProfiling()
        if (requests.length > 0) {
          this.#onProfile(null, profile, requests)
        }
      } catch (err) {
        this.#log.error({ err }, 'Failed to stop profiling')
        if (requests.length > 0) {
          this.#onProfile(err, null, requests)
        }
      }
    }
  }

  async #startProfilingLoop () {
    try {
      this.#nextProfileTimestamp = Date.now() + this.#duration
      await this.#startProfiling()
    } catch (err) {
      this.#log.error({ err }, 'Failed to start profiling')
      const requests = this.#getProfileRequests()
      this.#onProfile(err, null, requests)
      return
    }

    this.#getProfileInterval = setInterval(
      () => {
        this.#nextProfileTimestamp = Date.now() + this.#duration
        this.#processProfile()
      },
      this.#duration
    ).unref()
  }

  async #processProfile () {
    try {
      const profile = await this.#getProfile()
      const requests = this.#getProfileRequests(profile.timestamp)
      this.#onProfile(null, profile, requests)
    } catch (err) {
      this.#log.error({ err }, 'Failed to generate a profile')
      const requests = this.#getProfileRequests()
      this.#onProfile(err, null, requests)
    }

    if (this.#requests.length === 0) {
      this.#scheduleStopProfiling()
    }
  }

  #scheduleStopProfiling () {
    // Stop profiling after the duration/2 if there are no more requests
    this.#stopProfileTimeout = setTimeout(
      () => this.stop(),
      this.#duration / 2
    ).unref()
  }

  #unscheduleStopProfiling () {
    if (this.#stopProfileTimeout) {
      clearTimeout(this.#stopProfileTimeout)
      this.#stopProfileTimeout = null
    }
  }

  async #startProfiling () {
    this.#isProfiling = true
    this.#log.info('Starting profiling')

    await this.#runtime.sendCommandToApplication(
      this.#workerId, 'startProfiling', this.#profileOptions
    )
  }

  async #stopProfiling () {
    this.#isProfiling = false
    this.#log.info('Stopping profiling')

    try {
      const profile = await this.#runtime.sendCommandToApplication(
        this.#workerId, 'stopProfiling', this.#profileOptions
      )
      return profile
    } catch (err) {
      // Ignore errors if the app is already closing
      this.#log.debug({ err }, 'Failed to stop profiling')
    }
  }

  async #getProfile () {
    this.#log.info('Getting profile from worker')

    const [state, profile] = await Promise.all([
      this.#runtime.sendCommandToApplication(this.#workerId, 'getProfilingState', { type: this.#type }),
      this.#runtime.sendCommandToApplication(this.#workerId, 'getLastProfile', { type: this.#type })
    ])
    return { data: profile, timestamp: state.latestProfileTimestamp }
  }

  #getProfileRequests (profileTimestamp) {
    if (profileTimestamp === undefined) {
      const requests = this.#requests
      this.#requests = []
      return requests
    }

    let processedIndex = 0
    for (let i = 0; i < this.#requests.length; i++) {
      if (this.#requests[i].timestamp <= profileTimestamp) {
        processedIndex = i + 1
      }
    }
    return this.#requests.splice(0, processedIndex)
  }
}

async function flamegraphs (app, _opts) {
  const isFlamegraphsDisabled = app.env.PLT_DISABLE_FLAMEGRAPHS
  const flamegraphsIntervalSec = app.env.PLT_FLAMEGRAPHS_INTERVAL_SEC
  const statesRefreshInterval = app.env.PLT_FLAMEGRAPHS_STATES_REFRESH_INTERVAL ?? 10 * 1000

  const durationMillis = parseInt(flamegraphsIntervalSec) * 1000

  const profilers = {}
  const profilersConfigs = {}
  const profilersPauseReqs = {}

  app.setupFlamegraphs = async () => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, skipping profiling')
      return
    }

    const runtime = app.watt.runtime
    const { applications } = await runtime.getApplications()

    for (const application of applications) {
      const appDetails = await runtime.getApplicationDetails(application.id)
      const sourceMaps = appDetails.sourceMaps ?? false
      profilersConfigs[application.id] = { durationMillis, sourceMaps }
    }

    setInterval(() => {
      const states = getProfilersStates()
      const applicationId = app.instanceConfig?.applicationId
      if (applicationId && states.length > 0) {
        sendProfilingStates(
          applicationId,
          app.instanceId,
          statesRefreshInterval,
          states
        ).catch(err => app.log.warn({ err }, 'Failed to send profiling states'))
      }
    }, statesRefreshInterval).unref()
  }

  app.requestFlamegraphs = async (options = {}) => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, flamegraphs are disabled')
      return
    }

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    if (!scalerUrl) {
      app.log.error('No scaler URL found in ICC services, cannot send flamegraph')
      throw new Error('No scaler URL found in ICC services, cannot send flamegraph')
    }

    const runtime = app.watt.runtime

    let { serviceIds, alertId, profileType = 'cpu' } = options

    const servicesWorkers = {}
    const workers = await runtime.getWorkers()

    for (const workerId in workers) {
      const workerInfo = workers[workerId]
      const serviceId = workerInfo.application

      servicesWorkers[serviceId] ??= []
      servicesWorkers[serviceId].push(workerId)
    }

    for (const serviceId in profilers) {
      const workerProfilers = profilers[serviceId]
      for (const profileType in workerProfilers) {
        const profiler = workerProfilers[profileType]
        const workerId = profiler.workerId
        if (workers[workerId]) continue
        if (profiler.isProfiling) {
          profiler.stop()
        }
        delete profilers[serviceId][profileType]
      }
    }

    serviceIds ??= Object.keys(servicesWorkers)

    for (const serviceId of serviceIds) {
      const { isPaused, remainingTimeSec } = isProfilingPaused(serviceId)
      if (isPaused) {
        app.log.info(
          { serviceId },
          `Skipping service profiling, it is paused for ${remainingTimeSec}s`
        )
        continue
      }

      profilers[serviceId] ??= {}

      let profiler = profilers[serviceId][profileType]
      if (!profiler) {
        const workerId = servicesWorkers[serviceId][0]
        const config = profilersConfigs[serviceId]
        profiler = new Profiler({
          app,
          workerId,
          type: profileType,
          duration: config.durationMillis,
          sourceMaps: config.sourceMaps,
          onProfile: createProfileHandler(scalerUrl, workerId, profileType)
        })
        profilers[serviceId][profileType] = profiler
      }

      profiler.requestProfile({ alertId })
    }
  }

  // Method to be called when the worker ELU is very high
  // to stop profiling and wait for app to go back to normal
  app.pauseProfiling = async (options = {}) => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, flamegraphs are disabled')
      return
    }

    const { serviceId, timeout } = options

    profilersPauseReqs[serviceId] = { timestamp: timeout + Date.now() }

    const serviceProfilers = profilers[serviceId]
    if (!serviceProfilers) {
      app.log.debug({ serviceId }, 'Skipping service profiling pause, no profilers found')
      return
    }

    for (const profilerType in profilers[serviceId]) {
      const profiler = profilers[serviceId][profilerType]
      app.log.info({ serviceId, profilerType }, 'Pausing service profiling due to high ELU')
      await profiler.stop()
    }
  }

  function isProfilingPaused (serviceId) {
    let isPaused = false
    let remainingTimeSec = 0
    let pauseEndTimestamp = null

    const pauseReq = profilersPauseReqs[serviceId]
    if (pauseReq) {
      const now = Date.now()
      isPaused = pauseReq.timestamp > now
      pauseEndTimestamp = pauseReq.timestamp
      remainingTimeSec = Math.round((pauseReq.timestamp - now) / 1000)
    }

    return { isPaused, pauseEndTimestamp, remainingTimeSec }
  }

  function getProfilersStates () {
    const states = []

    for (const serviceId in profilers) {
      const serviceProfilers = profilers[serviceId]
      const { isPaused, pauseEndTimestamp } = isProfilingPaused(serviceId)

      for (const profileType in serviceProfilers) {
        const profiler = serviceProfilers[profileType]

        const isProfiling = profiler.isProfiling
        const nextProfileTimestamp = profiler.nextProfileTimestamp

        if (!isProfiling && !isPaused) continue

        states.push({
          serviceId,
          profileType,
          isProfiling,
          isPaused,
          pauseEndTimestamp,
          nextProfileTimestamp
        })
      }
    }

    return states
  }

  function createProfileHandler (scalerUrl, workerId, profileType) {
    const serviceId = workerId.split(':')[0]

    return async (err, profile, requests) => {
      if (err) {
        app.log.error({ err }, 'Failed to generate a profile')
        return
      }

      const alertIds = []
      for (const request of requests) {
        if (request.alertId) {
          alertIds.push(request.alertId)
        }
      }

      try {
        const alertId = alertIds.shift()
        const flamegraph = await sendServiceFlamegraph(
          scalerUrl,
          serviceId,
          profile.data,
          profileType,
          alertId
        )

        if (alertIds.length > 0) {
          await _attachFlamegraphToAlerts(
            scalerUrl,
            serviceId,
            flamegraph.id,
            profile.data,
            profileType,
            alertIds
          )
        }
      } catch (err) {
        app.log.error({ err, workerId }, 'Failed to send flamegraph')
      }
    }
  }

  async function sendServiceFlamegraph (scalerUrl, serviceId, profile, profileType, alertId) {
    const podId = app.instanceId
    const url = `${scalerUrl}/pods/${podId}/services/${serviceId}/flamegraph`
    app.log.info({ serviceId, podId, profileType, alertId }, 'Sending flamegraph')

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

    const flamegraph = await body.json()

    app.log.info(
      { serviceId, podId, profileType, flamegraph },
      'Flamegraph successfully stored'
    )

    return flamegraph
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

  async function sendProfilingStates (
    applicationId,
    podId,
    expiresIn,
    states
  ) {
    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    if (!scalerUrl) {
      app.log.error('No scaler URL found in ICC services, cannot send flamegraph')
      throw new Error('No scaler URL found in ICC services, cannot send flamegraph')
    }

    const url = `${scalerUrl}/flamegraphs/states`
    app.log.debug('Sending profiling states')

    const authHeaders = await app.getAuthorizationHeader()
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        applicationId,
        podId,
        expiresIn,
        states
      })
    })

    if (statusCode !== 200) {
      const error = await body.text()
      app.log.error({ error }, 'Failed to send profiling states')
      throw new Error(`Failed to send profiling states: ${error}`)
    }
  }

  app.cleanupFlamegraphs = async () => {
    // Stop all tracked profilers in parallel
    const stopPromises = []
    for (const serviceId in profilers) {
      const serviceProfilers = profilers[serviceId]
      for (const profileType in serviceProfilers) {
        const profiler = serviceProfilers[profileType]
        stopPromises.push(profiler.stop())
      }
    }
    await Promise.all(stopPromises)
  }
}

export default flamegraphs
