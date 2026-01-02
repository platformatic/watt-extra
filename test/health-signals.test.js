import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Profile } from 'pprof-format'
import { request } from 'undici'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('should send health signals when service becomes unhealthy', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const receivedSignalReqs = []
  const receivedFlamegraphReqs = []

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    scaler: { version: 'v2' },
    processSignals: (req) => {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      receivedSignalReqs.push(req.body)
      return { alertId: 'test-alert-id' }
    },
    processFlamegraphs: (req) => {
      const alertId = req.query.alertId
      assert.strictEqual(alertId, 'test-alert-id')
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      receivedFlamegraphReqs.push(req.body)
      return { id: 'test-flamegraph-id' }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 2,
    PLT_FLAMEGRAPHS_PAUSE_ELU_TRESHOLD: 1
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  {
    const { statusCode } = await request('http://127.0.0.1:3042/custom-health-signal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'custom',
        value: 42,
        description: 'This is a custom health signal'
      })
    })
    assert.strictEqual(statusCode, 200)
  }

  {
    const { statusCode } = await request('http://127.0.0.1:3042/cpu-intensive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeout: 3000, elu: 0.99 })
    })
    assert.strictEqual(statusCode, 200)
  }

  assert.strictEqual(receivedSignalReqs.length, 1)

  const receivedSignalReq = receivedSignalReqs[0]
  assert.ok(receivedSignalReq, 'Alert should have been received')
  assert.strictEqual(receivedSignalReq.applicationId, applicationId)
  assert.strictEqual(receivedSignalReq.serviceId, 'main')
  assert.ok(receivedSignalReq.elu > 0.9)
  assert.ok(receivedSignalReq.heapUsed > 0)
  assert.ok(receivedSignalReq.heapTotal > 0)

  const receivedSignals = receivedSignalReq.signals
  assert.ok(receivedSignals.length > 3)

  const eluSignals = receivedSignals.filter(
    (signal) => signal.type === 'elu'
  )
  const customSignals = receivedSignals.filter(
    (signal) => signal.type === 'custom'
  )
  assert.strictEqual(customSignals.length, 1)

  for (const receivedSignal of eluSignals) {
    assert.strictEqual(receivedSignal.type, 'elu')
    assert.ok(receivedSignal.value > 0.8)
    assert.ok(receivedSignal.timestamp > 0)
  }
  for (const receivedSignal of customSignals) {
    assert.strictEqual(receivedSignal.type, 'custom')
    assert.strictEqual(receivedSignal.value, 42)
    assert.ok(receivedSignal.timestamp > 0)
  }

  // Wait for flamegraph to be generated (duration is 2 seconds)
  await sleep(2500)

  assert.strictEqual(receivedFlamegraphReqs.length, 1)

  const receivedFlamegraph = receivedFlamegraphReqs[0]
  const profile = Profile.decode(receivedFlamegraph)
  assert.ok(profile, 'Profile should be decoded')
})

test('should not attach flamegraph if ELU is too high', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const receivedSignalReqs = []
  const receivedFlamegraphReqs = []

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    scaler: { version: 'v2' },
    processSignals: (req) => {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      receivedSignalReqs.push(req.body)
      return { alertId: 'test-alert-id' }
    },
    processFlamegraphs: (req) => {
      const alertId = req.query.alertId
      assert.strictEqual(alertId, 'test-alert-id')
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      receivedFlamegraphReqs.push(req.body)
      return { id: 'test-flamegraph-id' }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 2,
    PLT_FLAMEGRAPHS_PAUSE_ELU_TRESHOLD: 0.5
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  {
    const { statusCode } = await request('http://127.0.0.1:3042/cpu-intensive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeout: 3000, elu: 0.99 })
    })
    assert.strictEqual(statusCode, 200)
  }

  assert.strictEqual(receivedSignalReqs.length, 1)

  const receivedSignalReq = receivedSignalReqs[0]
  assert.ok(receivedSignalReq, 'Alert should have been received')
  assert.strictEqual(receivedSignalReq.applicationId, applicationId)
  assert.strictEqual(receivedSignalReq.serviceId, 'main')

  const receivedSignals = receivedSignalReq.signals
  assert.ok(receivedSignals.length > 3)

  const eluSignals = receivedSignals.filter(
    (signal) => signal.type === 'elu'
  )

  for (const receivedSignal of eluSignals) {
    assert.strictEqual(receivedSignal.type, 'elu')
    assert.ok(receivedSignal.value > 0.8)
    assert.ok(receivedSignal.timestamp > 0)
  }

  // Wait for flamegraph to be generated (duration is 2 seconds)
  await sleep(2500)

  assert.strictEqual(receivedFlamegraphReqs.length, 0)
})

test('should stop profining and attach flamegraph as is when ELU is too high', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const receivedSignalReqs = []
  const receivedFlamegraphReqs = []

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    scaler: { version: 'v2' },
    processSignals: (req) => {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      receivedSignalReqs.push(req.body)
      return { alertId: 'test-alert-id' }
    },
    processFlamegraphs: (req) => {
      const alertId = req.query.alertId
      assert.strictEqual(alertId, 'test-alert-id')
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      receivedFlamegraphReqs.push(req.body)
      return { id: 'test-flamegraph-id' }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 60,
    PLT_FLAMEGRAPHS_PAUSE_ELU_TRESHOLD: 0.8,
    PLT_HEALTH_SIGNALS_BATCH_TIMEOUT: 1
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  {
    const { statusCode } = await request('http://127.0.0.1:3042/custom-health-signal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'custom',
        value: 42,
        description: 'This is a custom health signal'
      })
    })
    assert.strictEqual(statusCode, 200)
  }

  await sleep(3000)

  {
    // Should stop profiling due to high ELU
    const { statusCode } = await request('http://127.0.0.1:3042/cpu-intensive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeout: 2000, elu: 1 })
    })
    assert.strictEqual(statusCode, 200)
  }

  await sleep(1000)

  assert.strictEqual(receivedFlamegraphReqs.length, 1)
})
