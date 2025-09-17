import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('should spawn a service app sending the state', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName
  })

  process.env.PLT_TEST_APP_1_URL = 'http://test-app-1:3042'
  t.after(() => {
    delete process.env.PLT_TEST_APP_1_URL
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const { statusCode, body } = await request('http://127.0.0.1:9090/metrics', {
    headers: {
      accept: 'application/json',
    }
  })
  assert.strictEqual(statusCode, 200)

  const metrics = await body.json()

  {
    const eluMetrics = metrics.find((metric) => metric.name === 'nodejs_eventloop_utilization')
    assert.ok(eluMetrics)

    const labels = eluMetrics.values[0].labels
    assert.strictEqual(labels.applicationId, applicationId)
    assert.strictEqual(labels.serviceId, 'main')
  }
})
