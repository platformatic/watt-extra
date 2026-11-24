import assert from 'node:assert'
import { once } from 'node:events'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUpEnvironment } from './helper.js'
import { start } from '../index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('should emit the same runtime metrics to every listener', async (t) => {
  setUpEnvironment({
    PLT_APP_NAME: 'test-app',
    PLT_APP_DIR: join(__dirname, 'fixtures', 'service-1'),
    PLT_METRICS_COLLECTION_INTERVAL: '500'
  })

  const app = await start()
  t.after(() => app.close())

  let secondMetrics = null
  app.metrics.on('metrics', ({ metrics }) => {
    secondMetrics = metrics
  })

  const [{ metrics, workers, timestamp }] = await once(app.metrics, 'metrics', { signal: AbortSignal.timeout(5000) })

  assert.ok(Array.isArray(metrics))
  assert.ok(metrics.some((metric) => metric.name === 'nodejs_eventloop_utilization'))
  assert.deepStrictEqual(Object.keys(workers), ['main:0'])
  assert.strictEqual(typeof timestamp, 'number')
  assert.strictEqual(secondMetrics, metrics)
})
