import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import fastify from 'fastify'
import pino from 'pino'
import alerts from '../plugins/alerts.js'
import healthSignals from '../plugins/health-signals.js'

for (const version of ['v1', 'v2']) {
  test(`${version} monitoring consumes Watt 4 metrics and cleans up after repeated setup`, { timeout: 5000 }, async t => {
    const received = Promise.withResolvers()
    const server = fastify()
    server.post('/ready', async () => ({}))
    server.post(version === 'v1' ? '/alerts' : '/signals', async req => {
      received.resolve(req.body)
      return { id: 'alert-1' }
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    t.after(() => server.close())
    const url = `http://127.0.0.1:${server.server.address().port}`
    const runtime = new EventEmitter()
    const app = {
      log: pino({ level: 'silent' }),
      env: {
        PLT_ICC_URL: url,
        PLT_ALERTS_GRACE_PERIOD_SEC: 0,
        PLT_HEALTH_SIGNALS_SHORT_BATCH_TIMEOUT: 0,
        PLT_HEALTH_SIGNALS_LONG_BATCH_TIMEOUT: 0,
        PLT_ELU_HEALTH_SIGNAL_THRESHOLD: 0.85,
        PLT_HEALTH_SIGNALS_ELU_BATCH_THRESHOLD: 0.5,
        PLT_HEAP_HEALTH_SIGNAL_THRESHOLD: '512MB',
        PLT_HEALTH_SIGNALS_HEAP_BATCH_THRESHOLD: '256MB'
      },
      instanceConfig: { applicationId: 'app', scaler: { version }, iccServices: { scaler: { url } } },
      getAuthorizationHeaders: async () => ({}),
      sendFlamegraphs: async () => {},
      watt: { runtime, getHealthConfig: () => ({ maxHeapUsed: 0.9 }) }
    }
    await alerts(app)
    await healthSignals(app)
    t.after(() => {
      app.cleanupAlerts()
      app.cleanupHealthSignals()
    })
    for (let i = 0; i < 2; i++) {
      await app.setupAlerts()
      await app.setupHealthSignals()
    }
    assert.equal(runtime.listenerCount('application:worker:health:metrics'), 1)
    runtime.emit('application:worker:health:metrics', {
      id: 'api:0',
      application: 'api',
      currentHealth: { elu: 0.97, heapUsed: 1024 * 1024, heapTotal: 10 * 1024 * 1024 },
      healthSignals: []
    })
    const body = await received.promise
    assert.equal(body.applicationId, 'app')
    if (version === 'v1') {
      assert.equal(body.alert.unhealthy, true)
      assert.equal(body.alert.service, 'api')
    } else {
      assert.equal(body.signals.api.elu.workers['api:0'].values[0][1], 0.97)
    }
    app.cleanupAlerts()
    app.cleanupHealthSignals()
    assert.equal(runtime.eventNames().length, 0)
  })
}
