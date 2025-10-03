import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('should spawn a service app sending the state', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-health')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_MAX_WORKERS: 3
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  {
    const { statusCode } = await request('http://127.0.0.1:3042/service-2/cpu-intensive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeout: 5000 })
    })
    assert.strictEqual(statusCode, 200)
  }

  await sleep(10000)

  const workers = await app.watt.runtime.getWorkers()

  const service1Workers = []
  const service2Workers = []

  for (const worker of Object.values(workers)) {
    if (worker.application === 'service-1') {
      service1Workers.push(worker)
    }
    if (worker.application === 'service-2') {
      service2Workers.push(worker)
    }
  }

  assert.strictEqual(service1Workers.length, 1)
  assert.strictEqual(service2Workers.length, 2)
})

