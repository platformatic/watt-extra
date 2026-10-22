import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import pino from 'pino'
import Watt from '../lib/watt.js'

const log = pino({ level: 'silent' })
const require = createRequire(import.meta.url)

test('Watt 4 configuration preserves custom health and tracing while adding ICC settings', () => {
  const exporter = { type: 'console' }
  const config = {
    health: { enabled: false, interval: 2500, maxHeapUsed: 0.8 },
    tracing: { enabled: true, exporter, skip: [{ method: 'GET', path: '/health' }] },
    preload: ['./custom.js'],
    watch: true
  }
  new Watt({
    log,
    env: { PLT_APP_NAME: 'my-app', PLT_METRICS_PORT: 0 },
    instanceId: 'pod-1',
    instanceConfig: {
      applicationId: 'app-1',
      deploymentVersion: 'deployment-1',
      applicationMetricsLabel: 'app',
      enableOpenTelemetry: true,
      iccServices: { riskEngine: { url: 'http://risk.local' } }
    }
  }).configure(config)

  assert.deepEqual(config.health, { enabled: true, interval: 2500, maxHeapUsed: 0.8 })
  assert.equal(config.tracing.applicationName, 'my-app')
  assert.deepEqual(config.tracing.exporter[0], exporter)
  assert.equal(config.tracing.exporter[1].options.url, 'http://risk.local/v1/traces')
  assert.equal(config.tracing.skip[0].path, '/health')
  assert.deepEqual(config.metrics.labels, {
    serviceId: 'main', instanceId: 'pod-1', applicationId: 'app-1', deploymentVersion: 'deployment-1'
  })
  assert.equal(config.metrics.applicationLabel, 'app')
  assert.equal(config.metrics.port, 0)
  assert.deepEqual(config.preload, ['./custom.js', require.resolve('@platformatic/wattpm-pprof-capture')])
  assert.equal(config.watch, false)
})

test('ICC cache updates retain user interceptors without accumulating generated interceptors', async () => {
  const userInterceptor = { module: '/custom-interceptor.js' }
  const config = { undici: { interceptors: [userInterceptor] } }
  const watt = new Watt({
    log,
    env: { PLT_DEFAULT_CACHE_TAGS_HEADER: 'cache-tags' },
    instanceConfig: {
      enableSlicerInterceptor: true,
      httpCache: { clientOpts: { host: 'cache.local', port: 6379 } },
      config: { httpCacheConfig: { rules: [{ routeToMatch: '/initial', cacheTags: ['tag'] }] } }
    }
  })
  watt.configure(config)
  assert.equal(config.httpCache.store, require.resolve('undici-cache-redis'))
  assert.deepEqual(config.undici.interceptors[1].options.rules[0].headers, { 'cache-tags': ['tag'] })
  const updates = []
  watt.runtime = { updateUndiciInterceptors: async value => updates.push(value) }
  for (const route of ['/second', '/third']) {
    await watt.applyIccConfigUpdates({ httpCacheConfig: { rules: [{ routeToMatch: route }] } })
  }
  assert.equal(updates.length, 2)
  assert.equal(updates[1].interceptors.length, 2)
  assert.deepEqual(updates[1].interceptors[0], userInterceptor)
  assert.equal(updates[1].interceptors[1].options.rules[0].routeToMatch, '/third')
})
