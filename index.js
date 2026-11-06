import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import pino from 'pino'
import avvio from 'avvio'
import init from './plugins/init.js'
import env from './plugins/env.js'
import metadata from './plugins/metadata.js'
import compliancy from './plugins/compliancy.js'
import scheduler from './plugins/scheduler.js'
import update from './plugins/update.js'
import alert from './plugins/alerts.js'
import healthSignals from './plugins/health-signals.js'
import flamegraphs from './plugins/flamegraphs.js'
import auth from './plugins/auth.js'
import { ExtensionNotConfiguredError } from './lib/errors.js'

// PR #5254 keeps the configured object through loading and runtime construction.
// Weak keys isolate concurrent runtimes without retaining abandoned configuration loads.
const applications = new WeakMap()

export async function configure (config, { root, options = {} }) {
  const environment = { ...config.env, ...process.env, ...options.env, PLT_APP_DIR: root }
  const logger = pino({ level: options.env?.PLT_LOG_LEVEL ?? process.env.PLT_LOG_LEVEL ?? 'info' })
  const app = { log: logger }
  avvio(app)
  app.use(env, {
    dotenv: { path: join(root, '.env') },
    data: environment
  })
    .use(auth, { useAppEnv: true })
    .use(init, {
      setDeploymentVersion (version) {
        config.env = { ...config.env, PLT_DEPLOYMENT_VERSION: version }
      }
    })
    .use(alert)
    .use(healthSignals)
    .use(metadata)
    .use(compliancy)
    .use(scheduler)
    .use(update)
    .use(flamegraphs)

  try {
    await app.ready()
  } catch (err) {
    await app.closeAuth?.()
    throw err
  }

  app.sendToICC = async () => {
    if (!app.env.PLT_ICC_URL) return
    if (!app.instanceConfig) await app.initApplication()
    await app.connectToUpdates()
    await app.sendMetadata()
    await app.checkCompliancy()
    await app.sendSchedulerInfo()
  }

  // Configuration can be loaded without ever starting a runtime. Leave no live resources.
  try {
    app.watt.configure(config)
    applications.set(config, app)
  } finally {
    await app.closeAuth()
  }
}

export async function setup ({ runtime, logger }) {
  // The metadata form retains identity; the public configuration getter returns a snapshot.
  const config = runtime.getRuntimeConfig(true)
  const app = applications.get(config)
  if (!app) {
    throw new ExtensionNotConfiguredError()
  }
  applications.delete(config)
  app.log = logger

  const controller = new AbortController()
  const { signal } = controller
  let synchronization = null
  let closing = null

  // Register before Watt decides whether worker health metrics should be collected.
  // The actual consumers may only become available after ICC recovers.
  function collectHealthMetrics () {}

  async function synchronize () {
    let retryInterval = Math.max(200, Number(app.env.PLT_ICC_RETRY_TIME))
    while (!signal.aborted) {
      try {
        await app.watt.applySchedulerMode()
        await app.setupAlerts()
        await app.setupHealthSignals()
        await app.setupFlamegraphs()
        await app.sendToICC()
        return
      } catch (err) {
        if (signal.aborted) {
          return
        }
        logger.error({ err, retryInterval }, 'Failed to synchronize with ICC, retrying')
        await setTimeout(retryInterval, undefined, { signal })
        retryInterval = Math.min(retryInterval * 2, 60000)
      }
    }
  }

  function onStarted () {
    synchronization = synchronize().catch(err => {
      if (!signal.aborted) {
        logger.error({ err }, 'Failed to synchronize with ICC')
      }
    })
  }

  function onApplicationStarted () {
    app.watt.applySchedulerMode().catch(err => {
      logger.error({ err }, 'Failed to pause application scheduler jobs')
    })
  }

  async function cleanup () {
    controller.abort()
    runtime.removeListener('started', onStarted)
    runtime.removeListener('application:started', onApplicationStarted)
    runtime.removeListener('application:worker:health:metrics', collectHealthMetrics)
    try {
      await app.closeUpdates()

      // Let an in-flight synchronization settle before removing the resources it can install.
      await synchronization
      app.cleanupAlerts()
      app.cleanupHealthSignals()
      await app.cleanupFlamegraphs()
    } finally {
      await app.closeAuth?.()
    }
  }

  function close () {
    closing ??= cleanup()
    return closing
  }

  try {
    await auth(app, { env: app.env })
    await app.watt.attach(runtime)
    runtime.on('application:worker:health:metrics', collectHealthMetrics)
    runtime.once('started', onStarted)
    runtime.on('application:started', onApplicationStarted)
  } catch (err) {
    await close()
    throw err
  }

  return { stop: close, close }
}
