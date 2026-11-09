import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import pino from 'pino'
import { configure, setup } from '../index.js'
import { startICC } from './helper.js'

for (const failures of [2, 5, 0]) {
  test(`ICC synchronization retries ${failures} failures then stops after success`, { timeout: 20000 }, async t => {
    const attempts = []
    let starting = false
    const saved = Promise.withResolvers()
    const icc = await startICC(t, {
      port: 0,
      controlPlaneResponse () {
        if (starting) attempts.push(Date.now())
        if (failures && (!starting || attempts.length <= failures)) {
          throw Object.assign(new Error('ICC unavailable'), { statusCode: 503 })
        }
        return { applicationId: 'retry-test' }
      },
      saveApplicationInstanceState: saved.resolve
    })
    const logger = pino({ level: 'silent' })
    const config = { applications: [] }
    await configure(config, {
      root: import.meta.dirname,
      options: {
        env: {
          PLT_ICC_URL: `http://127.0.0.1:${icc.server.address().port}`,
          PLT_ICC_RETRY_TIME: 200,
          PLT_LOG_LEVEL: 'silent',
          PLT_DISABLE_FLAMEGRAPHS: true
        }
      }
    })
    const runtime = Object.assign(new EventEmitter(), {
      logger,
      getRuntimeConfig: () => config,
      getRuntimeMetadata: () => ({}),
      getWorkers: () => ({}),
      getSchedulerJobs: () => [],
      updateSharedContext: async () => {},
      updateMetricsConfig: async () => {},
      updateUndiciInterceptors: async () => {}
    })
    const extension = await setup({ runtime, logger })
    t.after(() => extension.close())
    starting = true
    runtime.emit('started')
    await saved.promise
    assert.equal(attempts.length, failures ? failures + 1 : 0)
    const delays = attempts.slice(1).map((time, i) => time - attempts[i])
    for (let i = 0; i < delays.length; i++) {
      assert.ok(delays[i] >= 190 * 2 ** i, `retry ${i + 1} backs off exponentially`)
    }
    const count = attempts.length
    await setTimeout(250)
    assert.equal(attempts.length, count, 'No further retries after success')
  })
}
