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
      // Real ICC returns { alerts: [{ serviceId, workerId, alertId }] }
      return {
        alerts: [
          { serviceId: 'main', workerId: 'main:0', alertId: 'test-alert-id' }
        ]
      }
    },
    processFlamegraphs: (req) => {
      const alertId = req.query.alertId
      assert.strictEqual(alertId, 'test-alert-id')
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      receivedFlamegraphReqs.push(req.body)
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 2,
    PLT_FLAMEGRAPHS_ELU_THRESHOLD: 0
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // Wait for the first flamegraph to be generated
  await sleep(5000)

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
      body: JSON.stringify({ timeout: 3000 })
    })
    assert.strictEqual(statusCode, 200)
  }

  // Multiple batches may be sent due to timing, verify we received at least one
  assert.ok(receivedSignalReqs.length >= 1, `Expected at least 1 signal request, got ${receivedSignalReqs.length}`)

  // Use the last signal request which should have the most complete data
  const receivedSignalReq = receivedSignalReqs[receivedSignalReqs.length - 1]
  assert.ok(receivedSignalReq, 'Signal request should have been received')
  assert.strictEqual(receivedSignalReq.applicationId, applicationId)
  assert.ok(receivedSignalReq.runtimeId, 'runtimeId should be present')
  assert.ok(typeof receivedSignalReq.runtimeId === 'string', 'runtimeId should be a string')
  assert.ok(receivedSignalReq.batchStartedAt, 'batchStartedAt should be present')
  assert.ok(typeof receivedSignalReq.batchStartedAt === 'number', 'batchStartedAt should be a number')

  // Verify v2 signals format: { serviceId: { elu: { options, workers }, heap: { options, workers } } }
  const signals = receivedSignalReq.signals
  assert.ok(signals, 'signals should be present')
  assert.ok(signals.main, 'main service signals should be present')

  // Check ELU signals structure
  const eluSignals = signals.main.elu
  assert.ok(eluSignals, 'ELU signals should be present')
  assert.ok(eluSignals.options, 'ELU options should be present')
  assert.ok(typeof eluSignals.options.threshold === 'number', 'ELU threshold should be a number')
  assert.ok(eluSignals.workers, 'ELU workers should be present')
  assert.ok(typeof eluSignals.workers === 'object', 'ELU workers should be an object')

  // Check heap signals structure
  const heapSignals = signals.main.heap
  assert.ok(heapSignals, 'Heap signals should be present')
  assert.ok(heapSignals.options, 'Heap options should be present')
  assert.ok(typeof heapSignals.options.threshold === 'number', 'Heap threshold should be a number')
  assert.ok(heapSignals.workers, 'Heap workers should be present')
  assert.ok(typeof heapSignals.workers === 'object', 'Heap workers should be an object')

  // Verify ELU workers have values in tuple format [timestamp, value]
  const eluWorkerIds = Object.keys(eluSignals.workers)
  assert.ok(eluWorkerIds.length > 0, 'Should have at least one ELU worker')
  for (const workerId of eluWorkerIds) {
    const worker = eluSignals.workers[workerId]
    assert.ok(Array.isArray(worker.values), 'ELU worker values should be an array')
    assert.ok(worker.values.length > 0, 'ELU worker should have values')
    for (const tuple of worker.values) {
      assert.ok(Array.isArray(tuple), 'ELU value should be a tuple')
      assert.strictEqual(tuple.length, 2, 'ELU tuple should have 2 elements')
      assert.ok(typeof tuple[0] === 'number', 'ELU timestamp should be a number')
      assert.ok(typeof tuple[1] === 'number', 'ELU value should be a number')
    }
  }

  // Check that at least one ELU value is high (from CPU intensive operation)
  let highEluFound = false
  for (const workerId of eluWorkerIds) {
    for (const [, value] of eluSignals.workers[workerId].values) {
      if (value > 0.9) {
        highEluFound = true
        break
      }
    }
    if (highEluFound) break
  }
  assert.ok(highEluFound, 'Should have at least one high ELU value')

  // Verify heap workers have values in tuple format [timestamp, value]
  const heapWorkerIds = Object.keys(heapSignals.workers)
  assert.ok(heapWorkerIds.length > 0, 'Should have at least one heap worker')
  for (const workerId of heapWorkerIds) {
    const worker = heapSignals.workers[workerId]
    assert.ok(Array.isArray(worker.values), 'Heap worker values should be an array')
    assert.ok(worker.values.length > 0, 'Heap worker should have values')
    for (const tuple of worker.values) {
      assert.ok(Array.isArray(tuple), 'Heap value should be a tuple')
      assert.strictEqual(tuple.length, 2, 'Heap tuple should have 2 elements')
      assert.ok(typeof tuple[0] === 'number', 'Heap timestamp should be a number')
      assert.ok(typeof tuple[1] === 'number', 'Heap value should be a number')
    }
  }

  // Wait for the second flamegraph to be generated
  await sleep(2000)

  // assert.strictEqual(receivedFlamegraphReqs.length, 1)

  const receivedFlamegraph = receivedFlamegraphReqs[0]
  const profile = Profile.decode(receivedFlamegraph)
  assert.ok(profile, 'Profile should be decoded')
})
