'use strict'

import { request } from 'undici'

async function flamegraphs (app, _opts) {
  const isFlamegraphsDisabled = app.env.PLT_DISABLE_FLAMEGRAPHS
  const flamegraphsIntervalSec = app.env.PLT_FLAMEGRAPHS_INTERVAL_SEC

  const durationMillis = parseInt(flamegraphsIntervalSec) * 1000

  app.setupFlamegraphs = async () => {
    if (isFlamegraphsDisabled) {
      app.log.info('PLT_DISABLE_FLAMEGRAPHS is set, skipping profiling')
      return
    }

    app.log.info('Start profiling services')

    const runtime = app.wattpro.runtime
    const { applications } = await runtime.getApplications()

    const promises = []
    for (const application of applications) {
      const promise = runtime.sendCommandToApplication(
        application.id,
        'startProfiling',
        { durationMillis }
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

    let { serviceIds, alertId } = options

    const scalerUrl = app.instanceConfig?.iccServices?.scaler?.url
    if (!scalerUrl) {
      app.log.error('No scaler URL found in ICC services, cannot send flamegraph')
      throw new Error('No scaler URL found in ICC services, cannot send flamegraph')
    }

    const podId = app.instanceId
    const runtime = app.wattpro.runtime

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

        app.log.info({ serviceId, podId }, 'Sending flamegraph')

        const { statusCode, body } = await request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...authHeaders
          },
          query: alertId ? { alertId } : {},
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
