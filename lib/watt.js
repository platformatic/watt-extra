import os from 'node:os'
import dns from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { ensureLoggableError } from '@platformatic/foundation'

const require = createRequire(import.meta.url)

class Watt {
  #env
  #logger
  #applicationName
  #instanceId
  #instanceConfig
  #originalConfig
  #config
  #sharedContext

  constructor (app) {
    this.#env = app.env
    this.#logger = app.log
    this.#applicationName = app.applicationName || app.env.PLT_APP_NAME
    this.#instanceId = app.instanceId
    this.runtime = null
    this.#sharedContext = {}
    this.#instanceConfig = app.instanceConfig
  }

  // Extensions configure an existing runtime instead of owning its lifecycle.
  configure (config) {
    this.#config = config
    this.#originalConfig = structuredClone(config)
    this.#patchRuntimeConfig(config)
  }

  async attach (runtime) {
    this.runtime = runtime
    this.#logger = runtime.logger
    await this.#configureServices(runtime)
    await this.updateSharedContext(this.#sharedContext)
  }

  async applyIccConfigUpdates (config) {
    this.#logger.info({ config }, 'Applying ICC config updates')

    if (this.#instanceConfig) {
      this.#instanceConfig.config = config
    }

    if (config.httpCacheConfig) {
      try {
        const undiciConfig = await this.#getUndiciConfig()
        await this.runtime.updateUndiciInterceptors(undiciConfig)
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
        await this.runtime.updateUndiciInterceptors(undiciConfig)
        this.#logger.info('Updated undici interceptors after ICC recovery')
      } catch (err) {
        this.#logger.error({ err }, 'Failed to update undici interceptors after ICC recovery')
      }

      // Update metrics labels after ICC recovery.
      try {
        // Get current metrics config set by #configureRuntime
        const runtimeConfig = this.runtime.getRuntimeConfig()
        const currentMetrics = runtimeConfig.metrics || {}

        // Merge with ICC updates
        const updatedMetrics = {
          ...currentMetrics,
          labels: {
            ...currentMetrics.labels,
            applicationId: instanceConfig.applicationId,
            ...(instanceConfig.deploymentVersion ? { deploymentVersion: instanceConfig.deploymentVersion } : {})
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

  async updateSharedContext (context) {
    this.#sharedContext = context
    await this.runtime?.updateSharedContext({ context })
  }

  #patchRuntimeConfig (config) {
    this.#configureRuntime(config)
    this.#configureTelemetry(config)
    this.#configureHttpCaching(config)
    this.#configureHealth(config)
  }

  #configureRuntime (config) {
    const labels = {
      serviceId: 'main',
      instanceId: this.#instanceId
    }

    const applicationId = this.#instanceConfig?.applicationId
    if (applicationId) {
      labels.applicationId = applicationId
    }
    const deploymentVersion = this.#instanceConfig?.deploymentVersion
    if (deploymentVersion) {
      labels.deploymentVersion = deploymentVersion
    }

    config.watch = false
    if (this.#env.PLT_ICC_URL) {
      // ICC owns execution: jobs must be paused from registration, before startup.
      config.scheduler = { ...config.scheduler, autostart: false }
    }
    // The capture preload is passive until ICC enables profiling on a worker.
    const capture = require.resolve('@platformatic/wattpm-pprof-capture')
    config.preload = typeof config.preload === 'string' ? [config.preload] : (config.preload ?? [])
    if (!config.preload.includes(capture)) config.preload.push(capture)
    config.restartOnError = 1000
    config.metrics = {
      enabled: true,
      hostname: this.#env.PLT_APP_HOSTNAME || '0.0.0.0',
      port: this.#env.PLT_METRICS_PORT ?? 9090,
      labels,
      applicationLabel: this.#instanceConfig?.applicationMetricsLabel ?? 'serviceId',
      httpCustomLabels: [
        { name: 'callerTelemetryId', header: 'x-plt-telemetry-id', default: '' }
      ]
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
    const property = 'tracing'
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
    if (!config[property]) {
      config[property] = {
        enabled: enableOpenTelemetry,
        applicationName: `${this.#applicationName}`,
        skip: defaultSkip,
        exporter: iccExporter
      }
      return
    }

    // Merge with existing telemetry config
    // Always set applicationName for taxonomy diagrams (overrides user's value)
    config[property].applicationName = `${this.#applicationName}`

    // If ICC telemetry is enabled, add ICC exporter to user's exporters
    if (enableOpenTelemetry) {
      const userExporter = config[property].exporter
      if (!userExporter) {
        // No user exporter, just use ICC
        config[property].exporter = iccExporter
      } else if (Array.isArray(userExporter)) {
        // User has array of exporters, add ICC to the list
        config[property].exporter = [...userExporter, iccExporter]
      } else {
        // User has single exporter, convert to array with both
        config[property].exporter = [userExporter, iccExporter]
      }
    }

    // Merge skip patterns
    if (config[property].skip) {
      config[property].skip = [...config[property].skip, ...defaultSkip]
    } else {
      config[property].skip = defaultSkip
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
    config.health = {
      ...config.health,
      enabled: true
    }
  }

  getHealthConfig () {
    return this.#config?.health
  }

  async applySchedulerMode () {
    await this.#applySchedulerMode(this.runtime)
  }

  async #applySchedulerMode (runtime) {
    if (!this.#env.PLT_ICC_URL) {
      return
    }

    const jobs = await runtime.getSchedulerJobs()

    const activeJobs = jobs.filter(job => !job.paused)
    const results = await Promise.allSettled(
      activeJobs.map(job => runtime.pauseSchedulerJob(job.name))
    )

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.#logger.warn(
          { err: ensureLoggableError(result.reason), job: activeJobs[index].name },
          'Failed to pause runtime scheduler job for ICC coordination'
        )
      }
    }

    this.#logger.info({ jobs: jobs.map(job => job.name) }, 'Runtime scheduler jobs paused for ICC coordination')
  }

  async #configureServices (runtime) {
    const config = runtime.getRuntimeConfig()

    for (const app of config.applications ?? []) {
      if (app.type === '@platformatic/next') {
        await this.#configureNextService(runtime, app)
      } else if (
        [
          '@platformatic/service',
          '@platformatic/gateway',
          '@platformatic/db'
        ].includes(app.type)
      ) {
        await this.#configurePlatformaticServices(runtime, app)
      } else if (app.type === '@platformatic/regina') {
        await this.#configureReginaService(runtime, app)
      }
    }
  }

  async #configureNextService (runtime, service) {
    let nextPackage
    let nextSchema

    try {
      nextPackage = createRequire(
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
            ...service.resolvedConfig?.cache,
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
      service.resolvedConfig?.server?.port !== undefined &&
      nextSchema.properties.next?.properties.trailingSlash?.type === 'boolean'
    ) {
      patches.push({ op: 'add', path: '/next/trailingSlash', value: true })
    }

    if (patches.length) {
      this.#patchService(runtime, service.id, patches)
    }
  }

  async #configurePlatformaticServices (runtime, app) {
    const config = app.resolvedConfig
    if (config?.server?.port !== undefined) {
      const patches = [{ op: 'add', path: '/server/trustProxy', value: true }]

      if (this.#env.PLT_APP_HOSTNAME) {
        patches.push({ op: 'add', path: '/server/hostname', value: this.#env.PLT_APP_HOSTNAME })
      }
      if (this.#env.PLT_APP_PORT !== undefined) {
        patches.push({ op: 'add', path: '/server/port', value: this.#env.PLT_APP_PORT })
      }
      if (config.server.https) {
        patches.push({ op: 'remove', path: '/server/https' })
      }

      this.#patchService(runtime, app.id, patches)
    }
  }

  async #configureReginaService (runtime, app) {
    const privateIp = await this.#getPrivateIp()
    const port = app.resolvedConfig?.server?.port
    const address = `http://${privateIp}:${port}`

    this.#patchService(runtime, app.id, [
      { op: 'add', path: '/regina/memberAddress', value: address }
    ])
  }

  async #getPrivateIp () {
    const { address } = await dns.lookup(os.hostname())
    return address
  }

  #patchService (runtime, id, patches) {
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
