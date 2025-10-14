'use strict'

import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'

async function flamegraphs (app, _opts) {
  const isFlamegraphsDisabled = app.env.PLT_DISABLE_FLAMEGRAPHS
  const flamegraphsIntervalSec = app.env.PLT_FLAMEGRAPHS_INTERVAL_SEC
  const flamegraphsELUThreshold = app.env.PLT_FLAMEGRAPHS_ELU_THRESHOLD
  const flamegraphsGracePeriod = app.env.PLT_FLAMEGRAPHS_GRACE_PERIOD

  const durationMillis = parseInt(flamegraphsIntervalSec) * 1000
  const eluThreshold = parseInt(flamegraphsELUThreshold)
  const gracePeriod = parseInt(flamegraphsGracePeriod)

  app.setupFlamegraphs = async () => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, skipping profiling')
      return
    }

    app.log.info('Start profiling services')

    await sleep(gracePeriod)

    const runtime = app.watt.runtime
    const { applications } = await runtime.getApplications()

    const promises = []
    for (const application of applications) {
      const promise = runtime.sendCommandToApplication(
        application.id,
        'startProfiling',
        { durationMillis, eluThreshold }
      )
      promises.push(promise)
    }

    const results = await Promise.allSettled(promises)
    for (const result of results) {
      if (result.status === 'rejected') {
        app.log.error({ result }, 'Failed to start profiling')
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
      try {
        const profile = await runtime.sendCommandToApplication(serviceId, 'getLastProfile')
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
