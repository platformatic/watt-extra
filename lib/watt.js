import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import semver from 'semver'

const require = createRequire(import.meta.url)

// Simple replacement for ensureLoggableError
function ensureLoggableError (err) {
  if (!err) return err
  if (typeof err === 'string') return new Error(err)
  if (err instanceof Error) return err
  return new Error(String(err))
}

async function restartRuntime (runtime) {
  runtime.logger.info('Received SIGUSR2, restarting all services ...')

  try {
    await runtime.restart()
  } catch (err) {
    runtime.logger.error(
      { err: ensureLoggableError(err) },
      'Failed to restart services.'
    )
  }
}

class Watt {
  #env
  #logger
  #require
  #appDir
  #applicationName
  #instanceId
  #instanceConfig
  #originalConfig
  #config
  #sharedContext

  constructor (app) {
    this.#env = app.env
    this.#logger = app.log
    this.#appDir = app.env.PLT_APP_DIR
    this.#applicationName = app.applicationName || app.env.PLT_APP_NAME
    this.#require = createRequire(join(this.#appDir, 'package.json'))
    this.#instanceId = app.instanceId
    this.runtime = null
    this.#sharedContext = {}
    this.#instanceConfig = app.instanceConfig
  }

  async spawn () {
    try {
      this.runtime = await this.#createRuntime()
      this.#logger.info('Starting runtime -WATT')
      await this.runtime.start()
      await this.updateSharedContext(this.#sharedContext)
      this.#logger.info('Runtime started')
    } catch (err) {
      this.#logger.error(
        { err: ensureLoggableError(err) },
        'Failed to start runtime'
      )
      throw err
    }
  }

  async close () {
    if (this.runtime) {
      const runtime = this.runtime
      this.runtime = null

      this.#logger.info('Closing runtime')
      await runtime.close()
      this.#logger.info('Runtime closed')
    }
  }

  async applyIccConfigUpdates (config) {
    this.#logger.info({ config }, 'Applying ICC config updates')

    if (this.#instanceConfig) {
      this.#instanceConfig.config = config
    }

    if (config.httpCacheConfig) {
      try {
        const undiciConfig = await this.#getUndiciConfig()
        await this.runtime.updateUndiciInterceptors?.(undiciConfig)
      } catch (err) {
        this.#logger.error({ err }, 'Failed to update undici interceptors')
      }
    }
  }

  async updateInstanceConfig (instanceConfig) {
    this.#logger.info({ applicationId: instanceConfig?.applicationId }, 'Updating instance config after ICC recovery')

    const previousConfig = this.#instanceConfig
    this.#instanceConfig = instanceConfig

    // If we didn't have a config before and now we do, apply runtime updates
    if (!previousConfig && instanceConfig && this.runtime) {
      // Update undici interceptors
      try {
        const undiciConfig = this.#getUndiciConfig()
        await this.runtime.updateUndiciInterceptors?.(undiciConfig)
        this.#logger.info('Updated undici interceptors after ICC recovery')
      } catch (err) {
        this.#logger.error({ err }, 'Failed to update undici interceptors after ICC recovery')
      }

      // Update metrics config if runtime supports it
      if (typeof this.runtime.updateMetricsConfig === 'function') {
        try {
          // Get current metrics config set by #configureRuntime
          const runtimeConfig = this.runtime.getRuntimeConfig(true)
          const currentMetrics = runtimeConfig.metrics || {}

          // Merge with ICC updates
          const updatedMetrics = {
            ...currentMetrics,
            labels: {
              ...currentMetrics.labels,
              applicationId: instanceConfig.applicationId
            },
            applicationLabel: instanceConfig.applicationMetricsLabel ?? currentMetrics.applicationLabel
          }

          await this.runtime.updateMetricsConfig(updatedMetrics)
          this.#logger.info('Updated metrics config after ICC recovery')
        } catch (err) {
          this.#logger.error({ err }, 'Failed to update metrics config after ICC recovery')
        }
      }
    }
  }

  async updateSharedContext (context) {
    this.#sharedContext = context
    await this.runtime?.updateSharedContext?.({ context })
  }

  getRuntimeVersion () {
    const { version } = this.#require('@platformatic/runtime/package.json')
    return version
  }

  runtimeSupportsNewHealthMetrics () {
    const runtimeVersion = this.getRuntimeVersion()
    return semver.gte(runtimeVersion, '3.18.0')
  }

  async #createRuntime () {
    this.#logger.info('Creating runtime')
    const { create, transform } = this.#require('@platformatic/runtime')

    this.#logger.info('Building runtime')

    const runtime = await create(this.#appDir, null, {
      isProduction: true,
      transform: async (config) => {
        config = await transform(config)

        this.#config = config
        this.#originalConfig = structuredClone(config)

        this.#logger.info('Patching runtime config')

        this.#patchRuntimeConfig(config)
        return config
      }
    })

    /* c8 ignore next 3 */
    const restartListener = restartRuntime.bind(null, runtime)
    process.on('SIGUSR2', restartListener)
    runtime.on('closed', () => {
      process.removeListener('SIGUSR2', restartListener)
    })

    await this.#configureServices(runtime)

    try {
      await runtime.init()
    } catch (e) {
      await runtime.close()
      throw e
    }

    return runtime
  }

  #patchRuntimeConfig (config) {
    this.#configureRuntime(config)
    this.#configureTelemetry(config)
    this.#configureHttpCaching(config)
    this.#configureHealth(config)
    this.#configureScheduler(config)
  }

  #configureRuntime (config) {
    const { https, ...serverConfig } = config.server ?? {}
    config.server = {
      ...serverConfig,
      hostname: this.#env.PLT_APP_HOSTNAME || serverConfig.hostname,
      port: this.#env.PLT_APP_PORT || serverConfig.port
    }

    const labels = {
      serviceId: 'main',
      instanceId: this.#instanceId
    }

    const applicationId = this.#instanceConfig?.applicationId
    if (applicationId) {
      labels.applicationId = applicationId
    }

    config.hotReload = false
    config.restartOnError = 1000
    config.metrics = {
      server: 'hide',
      defaultMetrics: {
        enabled: true
      },
      hostname: this.#env.PLT_APP_HOSTNAME || '0.0.0.0',
      port: this.#env.PLT_METRICS_PORT || 9090,
      labels,
      applicationLabel: this.#instanceConfig?.applicationMetricsLabel ?? 'serviceId'
    }

    if (this.#env.PLT_DISABLE_FLAMEGRAPHS !== true) {
      if (config.preload === undefined) {
        config.preload = []
      }
      const pprofPath = require.resolve('@platformatic/wattpm-pprof-capture')
      config.preload.push(pprofPath)
    }

    this.#configureUndici(config)
    config.managementApi = true
  }

  #getUndiciConfig () {
    const config = this.#config

    const undiciConfig = structuredClone(this.#originalConfig.undici ?? {})

    if (undiciConfig.interceptors === undefined) {
      undiciConfig.interceptors = []
    }

    const enableSlicerInterceptor =
      this.#instanceConfig?.enableSlicerInterceptor ?? false
    if (enableSlicerInterceptor) {
      const slicerInterceptorConfig = this.#getSlicerInterceptorConfig(config)
      if (slicerInterceptorConfig) {
        undiciConfig.interceptors.push(slicerInterceptorConfig)
      }
    }

    const enableTrafficInterceptor =
      this.#instanceConfig?.enableTrafficInterceptor ?? false
    if (enableTrafficInterceptor) {
      const trafficInterceptorConfig =
        this.#getTrafficInterceptorConfig()
      if (trafficInterceptorConfig) {
        undiciConfig.interceptors.push(trafficInterceptorConfig)
      }
    }

    return undiciConfig
  }

  #configureUndici (config) {
    config.undici = this.#getUndiciConfig(config)
  }

  #getTrafficInterceptorConfig () {
    if (!this.#instanceConfig?.iccServices?.trafficInspector?.url) {
      return
    }
    const { origin: trafficInspectorOrigin, pathname: trafficInspectorPath } = new URL(
      this.#instanceConfig.iccServices.trafficInspector.url
    )
    return {
      module: require.resolve(
        'undici-traffic-interceptor'
      ),
      options: {
        labels: {
          applicationId: this.#instanceConfig.applicationId
        },
        bloomFilter: {
          size: 100000,
          errorRate: 0.01
        },
        maxResponseSize: 5 * 1024 * 1024, // 5MB
        trafficInspectorOptions: {
          url: trafficInspectorOrigin,
          pathSendBody: join(trafficInspectorPath, '/requests'),
          pathSendMeta: join(trafficInspectorPath, '/requests/hash')
        },
        matchingDomains: [this.#env.PLT_APP_INTERNAL_SUB_DOMAIN]
      }
    }
  }

  #getSlicerInterceptorConfig (config) {
    // We need to initialize the slicer interceptor even if there is no cache config
    // to be able to update the onfiguration at runtime
    const defaultCacheConfig = {
      rules: [
        {
          routeToMatch: 'http://plt.slicer.default/',
          headers: {}
        }
      ]
    }

    // This is the cache config from ICC
    const httpCacheConfig =
      this.#instanceConfig?.config?.httpCacheConfig ?? defaultCacheConfig
    let autoGeneratedConfig = null
    if (httpCacheConfig) {
      try {
        autoGeneratedConfig = httpCacheConfig
      } catch (e) {
        this.#logger.error(
          { err: ensureLoggableError(e) },
          'Failed to parse auto generated cache config'
        )
      }
    }

    let userConfig = null
    // This is the user config from the environment variable
    if (this.#env.PLT_CACHE_CONFIG) {
      try {
        userConfig = JSON.parse(this.#env.PLT_CACHE_CONFIG)
      } catch (e) {
        this.#logger.error(
          { err: ensureLoggableError(e) },
          'Failed to parse user cache config'
        )
      }
    }

    if (!userConfig && !autoGeneratedConfig) return null

    let cacheConfig = userConfig ?? autoGeneratedConfig
    if (autoGeneratedConfig && userConfig) {
      cacheConfig = this.#mergeCacheConfigs(autoGeneratedConfig, userConfig)
    }

    const cacheTagsHeader = this.#getCacheTagsHeader(config)

    for (const rule of cacheConfig.rules ?? []) {
      if (rule.cacheTags) {
        if (!rule.headers) {
          rule.headers = {}
        }
        rule.headers[cacheTagsHeader] = rule.cacheTags
        delete rule.cacheTags
      }
    }

    return {
      module: require.resolve('undici-slicer-interceptor'),
      options: cacheConfig
    }
  }

  #mergeCacheConfigs (autoGeneratedConfig, userConfig) {
    const mergedConfig = { ...userConfig }

    for (const rule of autoGeneratedConfig.rules ?? []) {
      const ruleIndex = mergedConfig.rules.findIndex(
        (r) => r.routeToMatch === rule.routeToMatch
      )

      if (ruleIndex === -1) {
        mergedConfig.rules.push(rule)
      }
    }

    return mergedConfig
  }

  #configureTelemetry (config) {
    const enableOpenTelemetry =
      !!this.#instanceConfig?.enableOpenTelemetry &&
      !!this.#instanceConfig?.iccServices?.riskEngine?.url

    const iccExporter = {
      type: 'otlp',
      options: {
        url: this.#instanceConfig?.iccServices?.riskEngine?.url + '/v1/traces',
        headers: {
          'x-platformatic-application-id': this.#instanceConfig?.applicationId
        },
        keepAlive: true,
        httpAgentOptions: {
          rejectUnauthorized: false
        }
      }
    }

    const defaultSkip = [
      { method: 'GET', path: '/documentation' },
      { method: 'GET', path: '/documentation/json' }
    ]

    // If user has no telemetry config, create default
    if (!config.telemetry) {
      config.telemetry = {
        enabled: enableOpenTelemetry,
        applicationName: `${this.#applicationName}`,
        skip: defaultSkip,
        exporter: iccExporter
      }
      return
    }

    // Merge with existing telemetry config
    // Always set applicationName for taxonomy diagrams (overrides user's value)
    config.telemetry.applicationName = `${this.#applicationName}`

    // If ICC telemetry is enabled, add ICC exporter to user's exporters
    if (enableOpenTelemetry) {
      const userExporter = config.telemetry.exporter
      if (!userExporter) {
        // No user exporter, just use ICC
        config.telemetry.exporter = iccExporter
      } else if (Array.isArray(userExporter)) {
        // User has array of exporters, add ICC to the list
        config.telemetry.exporter = [...userExporter, iccExporter]
      } else {
        // User has single exporter, convert to array with both
        config.telemetry.exporter = [userExporter, iccExporter]
      }
    }

    // Merge skip patterns
    if (config.telemetry.skip) {
      config.telemetry.skip = [...config.telemetry.skip, ...defaultSkip]
    } else {
      config.telemetry.skip = defaultSkip
    }
  }

  #configureHttpCaching (config) {
    const cacheTagsHeader = this.#getCacheTagsHeader(config)
    const httpCache = this.#instanceConfig?.httpCache?.clientOpts

    if (!httpCache?.host) {
      this.#logger.warn(
        'Missing required environment variables for Redis cache, not setting up HTTP cache'
      )
      return
    }

    config.httpCache = {
      ...config.httpCache,
      cacheTagsHeader,
      store: require.resolve('undici-cache-redis'),
      clientOpts: httpCache
    }
  }

  #configureHealth (config) {
    if (this.runtimeSupportsNewHealthMetrics()) {
      // New behavior: just force enabled to true, inherit everything else from app config
      config.health = {
        ...config.health,
        enabled: true
      }
    } else {
      config.health = {
        ...config.health,
        enabled: true,
        interval: 1000,
        maxUnhealthyChecks: 30
      }
    }
  }

  getHealthConfig () {
    return this.#config?.health
  }

  #configureScheduler (config) {
    // Disable all watt schedules. We do that because
    // we will create/update them in ICC, not on watt in memory
    if (config.scheduler) {
      config.scheduler = config.scheduler.map((scheduler) => ({
        ...scheduler,
        enabled: false
      }))
    }
  }

  async #configureServices (runtime) {
    if (typeof runtime.setApplicationConfigPatch !== 'function') {
      return
    }

    const config = runtime.getRuntimeConfig(true)

    for (const app of config.applications ?? []) {
      if (app.type === 'next') {
        await this.#configureNextService(runtime, app)
      } else if (
        [
          '@platformatic/service',
          '@platformatic/composer',
          '@platformatic/db'
        ].includes(app.type)
      ) {
        await this.#configurePlatformaticServices(runtime, app)
      }
    }
  }

  async #configureNextService (runtime, service) {
    let nextSchema

    try {
      const nextPackage = createRequire(
        resolve(service.path, 'index.js')
      ).resolve('@platformatic/next')
      nextSchema = JSON.parse(
        await readFile(resolve(nextPackage, '../schema.json'), 'utf8')
      )
    } catch (e) {
      this.#logger.error(
        { err: ensureLoggableError(e) },
        `Failed to load @platformatic/next schema for service ${service.id}`
      )
      throw e
    }

    const patches = []

    if ('cache' in nextSchema.properties) {
      const httpCache = this.#instanceConfig?.httpCache?.clientOpts || {}
      const { keyPrefix, host, port, username, password } = httpCache

      if (!keyPrefix || !host || !port) {
        this.#logger.warn(
          'Missing required environment variables for Redis cache, not setting up HTTP next cache'
        )
      } else {
        patches.push({
          op: 'add',
          path: '/cache',
          value: {
            adapter: 'valkey',
            url: `valkey://${username}:${password}@${host}:${port}`,
            prefix: keyPrefix,
            maxTTL: 604800 // 86400 * 7
          }
        })
      }
    }

    // Add trailingSlash true to Next entrypoints that support it
    // This is technically useless as Next.js will manage it at build time, but we keep it
    // in case in the future they compare build and production next.config.js
    if (
      service.entrypoint &&
      nextSchema.properties.next?.properties.trailingSlash?.type === 'boolean'
    ) {
      patches.push({ op: 'add', path: '/next/trailingSlash', value: true })
    }

    if (patches.length) {
      this.#patchService(runtime, service.id, patches)
    }
  }

  async #configurePlatformaticServices (runtime, app) {
    if (app.entrypoint) {
      const config = app
      const patches = [{ op: 'add', path: '/server/trustProxy', value: true }]

      if (!config.server) {
        patches.unshift({ op: 'add', path: '/server', value: {} })
      }

      patches.push({ op: 'remove', path: '/server/https' })

      this.#patchService(runtime, app.id, patches)
    }
  }

  async #patchService (runtime, id, patches) {
    this.#logger.info({ patches }, `Applying patches to service ${id} ...`)
    runtime.setApplicationConfigPatch(id, patches)
  }

  #getCacheTagsHeader (config) {
    const customCacheTagsHeader = config.httpCache?.cacheTagsHeader
    const defaultCacheTagsHeader = this.#env.PLT_DEFAULT_CACHE_TAGS_HEADER
    return customCacheTagsHeader ?? defaultCacheTagsHeader
  }
}

export default Watt
