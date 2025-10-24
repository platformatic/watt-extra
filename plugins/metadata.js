import {
  MetadataRuntimeError,
  MetadataError,
  MetadataStateError,
  MetadataAppIdError,
  MetadataRuntimeNotStartedError
} from '../lib/errors.js'

async function metadata (app, _opts) {
  async function sendMetadata () {
    // Skip metadata processing if ICC is not configured
    if (!app.env.PLT_ICC_URL) {
      app.log.info('PLT_ICC_URL not set, skipping metadata processing')
      return
    }

    const applicationId = app.instanceConfig?.applicationId
    const runtime = app.watt.runtime
    if (!applicationId) {
      app.log.warn('Cannot process metadata: no applicationId available')
      throw new MetadataAppIdError()
    }

    if (!runtime) {
      app.log.warn('Cannot process metadata: runtime not started')
      throw new MetadataRuntimeNotStartedError()
    }

    try {
      const { default: build, setDefaultHeaders } = await import('../clients/control-plane/control-plane.mjs')
      const controlPlaneClient = build(app.env.PLT_CONTROL_PLANE_URL)

      try {
        const [runtimeConfig, runtimeMetadata] = await Promise.all([
          runtime.getRuntimeConfig(),
          runtime.getRuntimeMetadata()
        ])

        const services = await Promise.all(
          runtimeConfig.applications.map((application) =>
            runtime.getApplicationDetails(application.id)
          )
        )

        const workersCount = getWorkersCount(runtimeConfig)
        for (const service of services) {
          const serviceWorkers = workersCount[service.id]
          if (serviceWorkers?.workers) {
            service.workers = serviceWorkers.workers
          }
          if (serviceWorkers?.minWorkers) {
            service.minWorkers = serviceWorkers.minWorkers
          }
          if (serviceWorkers?.maxWorkers) {
            service.maxWorkers = serviceWorkers.maxWorkers
          }
        }

        try {
          // There is a better way? We need to set the default headers for the client
          // every time, because the token might be expired
          // And we cannot set the global dispatcher because it's shared with the runtime main thread.
          setDefaultHeaders(await app.getAuthorizationHeader())
          await controlPlaneClient.saveApplicationInstanceState({
            id: app.instanceId,
            services,
            metadata: runtimeMetadata
          }, {
            headers: await app.getAuthorizationHeader()
          })
        } catch (error) {
          app.log.error('Failed to save application state to Control Plane', error)
          throw new MetadataStateError()
        }

        app.log.info('Runtime metadata processed')
      } catch (error) {
        if (error.code === 'PLT_METADATA_STATE_ERROR') {
          throw error
        }
        app.log.error(error, 'Failed in getting and processing runtime metadata')
        throw new MetadataRuntimeError()
      }
    } catch (error) {
      if (error.code === 'PLT_METADATA_APP_ID_ERROR' ||
          error.code === 'PLT_METADATA_RUNTIME_NOT_STARTED_ERROR' ||
          error.code === 'PLT_METADATA_RUNTIME_ERROR' ||
          error.code === 'PLT_METADATA_STATE_ERROR') {
        throw error
      }
      app.log.error(error, 'Failure in metadata processing')
      throw new MetadataError()
    }
  }
  app.sendMetadata = sendMetadata

  function getWorkersCount (runtimeConfig) {
    const verticalScalerConfig = runtimeConfig.verticalScaler
    const serviceWorkers = {}

    for (const application of runtimeConfig.applications) {
      const { workers } = application
      if (!workers) continue

      if (typeof workers === 'number') {
        serviceWorkers[application.id] = {
          workers,
          minWorkers: workers,
          maxWorkers: workers
        }
      }
      if (typeof workers === 'object') {
        serviceWorkers[application.id] = {
          workers: workers.static,
          minWorkers: workers.minimum ?? workers.static,
          maxWorkers: workers.maximum ?? workers.static
        }
      }
    }

    if (verticalScalerConfig?.enabled) {
      for (const applicationId in verticalScalerConfig.applications) {
        const scalingConfig = verticalScalerConfig.applications[applicationId]
        serviceWorkers[applicationId] ??= {}
        serviceWorkers[applicationId].maxWorkers ??= scalingConfig.maxWorkers
        serviceWorkers[applicationId].minWorkers ??= scalingConfig.minWorkers
      }
    }

    return serviceWorkers
  }
}

export default metadata
