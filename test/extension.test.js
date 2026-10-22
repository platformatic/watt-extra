import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { create } from '@platformatic/runtime'
import { test } from 'node:test'
import pino from 'pino'
import { configure, setup } from '../index.js'
import { startICC } from './helper.js'

const root = resolve(import.meta.dirname, '..')
const logger = pino({ level: 'silent' })

class ExtensionRuntime extends EventEmitter {
  constructor (config) {
    super()
    this.config = config
    this.logger = logger
    this.context = {}
    this.patches = new Map()
  }

  getRuntimeConfig () { return this.config }
  getRuntimeMetadata () { return { platformaticVersion: '4.0.0-alpha.3' } }
  getWorkers () { return {} }
  getSchedulerJobs () { return [] }
  async updateSharedContext ({ context }) { Object.assign(this.context, context) }
  async updateUndiciInterceptors () {}
  async updateMetricsConfig (config) { Object.assign(this.config.metrics, config) }
  setApplicationConfigPatch (id, patch) { this.patches.set(id, patch) }
}

test('v4 configuration keeps instances isolated and leaves process.env unchanged', async t => {
  const before = { ...process.env }
  const configs = []

  for (const name of ['first', 'second']) {
    const config = { applications: [], preload: './custom-preload.js' }
    await configure(config, {
      root,
      options: { env: { PLT_APP_NAME: name, PLT_ICC_URL: '', PLT_LOG_LEVEL: 'silent' } }
    })
    configs.push(config)
  }

  assert.deepEqual({ ...process.env }, before)
  assert.equal(configs[0].tracing.applicationName, 'first')
  assert.equal(configs[1].tracing.applicationName, 'second')
  assert.equal(configs[0].preload[0], './custom-preload.js')
  assert.match(configs[0].preload[1], /wattpm-pprof-capture/)
  assert.equal(configs[0].metrics.enabled, true)
  assert.equal(configs[0].server, undefined)
  assert.equal(configs[0].telemetry, undefined)
  assert.equal(configs[0].hotReload, undefined)

  for (const config of configs.reverse()) {
    const runtime = new ExtensionRuntime(config)
    const extension = await setup({ runtime, logger })
    t.after(() => extension.close())
    assert.equal(runtime.listenerCount('started'), 1)
    assert.equal(runtime.listenerCount('application:worker:health:metrics'), 1)
    runtime.emit('started')
    await extension.stop()
    await extension.close()
    assert.equal(runtime.eventNames().length, 0)
  }
})

test('v4 reports a coded error when configure was not called', async () => {
  await assert.rejects(setup({ runtime: new ExtensionRuntime({}), logger }), {
    code: 'PLT_EXTRA_EXTENSION_NOT_CONFIGURED'
  })
})

test('v4 registers ICC once and patches capabilities before applications start', async t => {
  let registrations = 0
  const icc = await startICC(t, {
    port: 0,
    controlPlaneResponse: () => {
      registrations++
      return { applicationId: 'v4-test', applicationName: 'v4-test', deploymentVersion: 'deployment-v4' }
    }
  })
  t.after(() => icc.close())
  const oldVersion = process.env.PLT_DEPLOYMENT_VERSION
  const config = { applications: [] }
  await configure(config, {
    root,
    options: { env: { PLT_ICC_URL: `http://127.0.0.1:${icc.server.address().port}`, PLT_LOG_LEVEL: 'silent' } }
  })
  assert.equal(config.env.PLT_DEPLOYMENT_VERSION, 'deployment-v4')
  assert.equal(process.env.PLT_DEPLOYMENT_VERSION, oldVersion)
  assert.equal(config.metrics.labels.applicationId, 'v4-test')

  // The loader resolves capability configuration between configure and setup.
  config.applications.push({
    id: 'api',
    type: '@platformatic/gateway',
    resolvedConfig: { server: { port: 0, https: { key: 'key', cert: 'cert' } } }
  })
  const runtime = new ExtensionRuntime(config)
  const extension = await setup({ runtime, logger })
  t.after(() => extension.close())
  assert.deepEqual(runtime.patches.get('api'), [
    { op: 'add', path: '/server/trustProxy', value: true },
    { op: 'remove', path: '/server/https' }
  ])
  assert.equal(registrations, 1)
  await extension.close()
  assert.equal(runtime.eventNames().length, 0)
})

test('published Watt boots through configure, serves requests and shuts down its extension', async t => {
  const runtime = await create(root, {
    logger: { level: 'silent' },
    applications: [{
      id: 'api',
      path: join(root, 'test/fixtures/extension-service')
    }],
    extensions: [{
      path: join(root, 'index.js'),
      options: {
        env: {
          PLT_ICC_URL: '',
          PLT_APP_NAME: 'v4-integration',
          PLT_METRICS_PORT: 0,
          PLT_LOG_LEVEL: 'silent'
        }
      }
    }]
  }, { isProduction: true, setupSignals: false })
  t.after(() => runtime.close())
  const started = once(runtime, 'started')
  await runtime.start()
  await started
  assert.equal(runtime.getRuntimeStatus(), 'started')
  assert.equal((await runtime.getRuntimeMetadata()).platformaticVersion, '4.0.0-alpha.3')
  const response = await runtime.inject('api', { method: 'GET', url: '/' })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).ok, true)
  assert.equal(runtime.getRuntimeConfig().tracing.applicationName, 'v4-integration')
  await setTimeout(50)
  await runtime.close()
  assert.equal(runtime.getRuntimeStatus(), 'closed')
  assert.equal(runtime.listenerCount('application:worker:health:metrics'), 0)
})

test('v4 recovers ICC after startup and cancels retry work on close', { timeout: 10000 }, async t => {
  let available = false
  let attempts = 0
  let extension = null
  const stateSaved = Promise.withResolvers()
  const icc = await startICC(t, {
    port: 0,
    controlPlaneResponse: (req) => {
      attempts++
      if (!available) {
        req.server.log.debug('ICC unavailable')
        throw Object.assign(new Error('Unavailable'), { code: 'TEST_ICC_UNAVAILABLE', statusCode: 503 })
      }
      return { applicationId: 'recovered', deploymentVersion: 'recovered-version' }
    },
    saveApplicationInstanceState: stateSaved.resolve
  })
  t.after(async () => {
    await extension?.close()
    await icc.close()
  })
  const config = { applications: [] }
  await configure(config, {
    root,
    options: {
      env: {
        PLT_ICC_URL: `http://127.0.0.1:${icc.server.address().port}`,
        PLT_LOG_LEVEL: 'silent',
        PLT_ICC_RETRY_TIME: 200
      }
    }
  })
  const runtime = new ExtensionRuntime(config)
  extension = await setup({ runtime, logger })
  assert.equal(attempts, 1)
  available = true
  runtime.emit('started')
  await stateSaved.promise
  assert.equal(runtime.context.deploymentVersion, 'recovered-version')
  assert.equal(config.metrics.labels.applicationId, 'recovered')
  await extension.close()
  const finalAttempts = attempts
  await setTimeout(250)
  assert.equal(attempts, finalAttempts)
  assert.equal(runtime.eventNames().length, 0)
})

test('published Watt applies ICC configuration to workers and reports runtime state', { timeout: 10000 }, async t => {
  const stateSaved = Promise.withResolvers()
  let registrations = 0
  const icc = await startICC(t, {
    port: 0,
    controlPlaneResponse () {
      registrations++
      return { applicationId: 'published-app', deploymentVersion: 'published-deployment' }
    },
    saveApplicationInstanceState: stateSaved.resolve
  })
  let runtime = null
  t.after(async () => {
    await runtime?.close()
    await icc.close()
  })
  runtime = await create(root, {
    logger: { level: 'error' },
    applications: [{ id: 'api', path: join(root, 'test/fixtures/extension-service') }],
    extensions: [{
      path: join(root, 'index.js'),
      options: {
        env: {
          PLT_ICC_URL: `http://127.0.0.1:${icc.server.address().port}`,
          PLT_METRICS_PORT: 0,
          PLT_LOG_LEVEL: 'silent',
          PLT_DISABLE_COMPLIANCE_CHECK: true,
          PLT_DISABLE_FLAMEGRAPHS: true
        }
      }
    }]
  }, { isProduction: true, setupSignals: false })
  await runtime.start()
  const response = await runtime.inject('api', {
    method: 'GET', url: '/', headers: { 'x-forwarded-for': '192.0.2.1' }
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true, ip: '192.0.2.1', deploymentVersion: 'published-deployment'
  })
  const { state } = await stateSaved.promise
  assert.equal(state.services[0].id, 'api')
  assert.equal(state.services[0].workers, 1)
  assert.equal(state.metadata.platformaticVersion, '4.0.0-alpha.3')
  assert.equal(registrations, 1)
  assert.equal(runtime.getRuntimeConfig().metrics.labels.applicationId, 'published-app')
  await runtime.close()
  assert.equal(runtime.listenerCount('application:worker:health:metrics'), 0)
})

test('closing the extension interrupts ICC retry backoff without closing Watt', { timeout: 5000 }, async t => {
  let attempts = 0
  const retried = Promise.withResolvers()
  const icc = await startICC(t, {
    port: 0,
    controlPlaneResponse () {
      if (++attempts === 2) retried.resolve()
      throw Object.assign(new Error('Unavailable'), { statusCode: 503 })
    }
  })
  t.after(() => icc.close())
  const config = { applications: [] }
  await configure(config, {
    root,
    options: {
      env: {
        PLT_ICC_URL: `http://127.0.0.1:${icc.server.address().port}`,
        PLT_ICC_RETRY_TIME: 60000,
        PLT_LOG_LEVEL: 'silent'
      }
    }
  })
  const runtime = new ExtensionRuntime(config)
  runtime.close = () => assert.fail('The extension must not close its host runtime')
  const extension = await setup({ runtime, logger })
  t.after(() => extension.close())
  runtime.emit('started')
  await retried.promise
  await setTimeout(20)
  await extension.close()
  assert.equal(attempts, 2)
  assert.equal(runtime.eventNames().length, 0)
})
