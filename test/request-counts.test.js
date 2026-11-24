import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'
import { RequestsCollector } from '../lib/requests-collector.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const COLLECTION_INTERVAL = 500

async function startApp (t, processRequestCounts) {
  const icc = await startICC(t, {
    applicationId: randomUUID(),
    applicationName: 'test-app',
    scaler: { version: 'v2' },
    processRequestCounts
  })

  setUpEnvironment({
    PLT_APP_NAME: 'test-app',
    PLT_APP_DIR: join(__dirname, 'fixtures', 'service-1'),
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_METRICS_COLLECTION_INTERVAL: String(COLLECTION_INTERVAL)
  })

  const app = await start()
  t.after(async () => {
    await app.close()
    await icc.close()
  })
  return app
}

async function sendRequests (count) {
  for (let i = 0; i < count; i++) {
    const { statusCode, body } = await request('http://127.0.0.1:3042/example')
    assert.strictEqual(statusCode, 200)
    await body.dump()
  }
}

test('should send the requests of each service in back-to-back intervals', async (t) => {
  const requestCounts = []
  await startApp(t, (req) => {
    requestCounts.push(req.body)
    return { success: true }
  })
  // The first read is not sent
  await sleep(COLLECTION_INTERVAL * 1.5)

  await sendRequests(5)
  await sleep(COLLECTION_INTERVAL * 4)

  assert.ok(requestCounts.length >= 2)
  for (const { entrypoints, from, to } of requestCounts) {
    assert.deepStrictEqual(entrypoints, ['main'])
    assert.ok(from < to)
  }
  for (let i = 1; i < requestCounts.length; i++) {
    assert.strictEqual(requestCounts[i].from, requestCounts[i - 1].to)
  }

  let mainRequests = 0
  for (const { requests } of requestCounts) {
    mainRequests += requests.main ?? 0
  }
  assert.strictEqual(mainRequests, 5)
})

test('should not send again the requests of a failed send', async (t) => {
  const requestCounts = []
  let isFailing = true
  await startApp(t, (req) => {
    requestCounts.push(req.body)
    if (isFailing) throw new Error('Scaler unavailable')
    return { success: true }
  })
  await sleep(COLLECTION_INTERVAL * 1.5)

  await sendRequests(5)
  await sleep(COLLECTION_INTERVAL * 2)
  const failedCount = requestCounts.length
  isFailing = false

  await sendRequests(3)
  await sleep(COLLECTION_INTERVAL * 2)

  for (let i = 1; i < requestCounts.length; i++) {
    assert.strictEqual(requestCounts[i].from, requestCounts[i - 1].to)
  }
  let mainRequests = 0
  for (const { requests } of requestCounts.slice(failedCount)) {
    mainRequests += requests.main ?? 0
  }
  assert.strictEqual(mainRequests, 3)
})

test('should warn once when the scaler does not support request counts, and keep sending', async (t) => {
  let sentCount = 0
  const app = await startApp(t, () => {
    sentCount++
    throw Object.assign(new Error('Route POST:/request-counts not found'), { statusCode: 404 })
  })

  const warnings = []
  const errors = []
  t.mock.method(app.log, 'warn', (message) => warnings.push(message))
  t.mock.method(app.log, 'error', (...args) => errors.push(args))
  await sleep(COLLECTION_INTERVAL * 5)

  assert.ok(sentCount >= 2)
  assert.strictEqual(warnings.length, 1)
  assert.match(warnings[0], /does not support request counts/)
  assert.deepStrictEqual(errors, [])
})

test('should count the requests of workers that come, go, do not answer and reuse ids', () => {
  const metricName = 'http_request_all_duration_seconds'
  const requestsCollector = new RequestsCollector(false)

  // The threads running, the cumulative counts each worker answered with (one per status code), the
  // expected requests
  const reads = [
    { threads: { 0: 10, 1: 11 }, counts: { 0: [3, 1], 1: [10, 0] }, requests: 14 },
    // Worker 1 does not answer, worker 2 starts
    { threads: { 0: 10, 1: 11, 2: 12 }, counts: { 0: [5, 1], 2: [7, 0] }, requests: 9 },
    // Worker 1 answers again, worker 0 stops, worker 3 starts during the read
    { threads: { 1: 11, 2: 12 }, counts: { 1: [13, 0], 2: [7, 0], 3: [2, 0] }, requests: 5 },
    // The ids 1 and 2 are reused: worker 1 is already over the count of the previous one
    { threads: { 1: 21, 2: 22, 3: 13 }, counts: { 1: [20, 0], 2: [1, 0], 3: [6, 0] }, requests: 25 },
    { threads: { 1: 31 }, counts: { 1: [25, 0] }, requests: 25 }
  ]
  for (const { threads, counts, requests } of reads) {
    const workers = {}
    for (const [workerId, thread] of Object.entries(threads)) {
      workers[`main:${workerId}`] = { thread }
    }

    // A value without a worker is not a worker's
    const metrics = [{ name: metricName, values: [{ metricName: `${metricName}_count`, value: 99, labels: { app: 'main' } }] }]
    for (const [workerId, workerCounts] of Object.entries(counts)) {
      const labels = { app: 'main', workerId: Number(workerId) }
      const values = workerCounts.map((value) => ({ metricName: `${metricName}_count`, value, labels }))
      metrics.push({ name: metricName, values })
    }

    assert.deepStrictEqual(requestsCollector.collect(metrics, workers, 'app'), { main: requests })
  }
})

test('should count every request while a real application scales and restarts', async (t) => {
  let mainRequests = 0
  const app = await startApp(t, (req) => {
    mainRequests += req.body.requests.main ?? 0
    return { success: true }
  })
  const { runtime } = app.watt
  await sleep(COLLECTION_INTERVAL * 1.5)

  const changes = [
    () => runtime.updateApplicationsResources([{ application: 'main', workers: 3 }]),
    () => runtime.updateApplicationsResources([{ application: 'main', workers: 1 }]),
    () => runtime.updateApplicationsResources([{ application: 'main', workers: 3 }]),
    () => runtime.restartApplication('main'),
    // Reuses the ids
    async () => {
      await runtime.stopApplication('main')
      await runtime.startApplication('main')
    }
  ]
  for (const change of changes) {
    await change()
    await sendRequests(6)
    await sleep(COLLECTION_INTERVAL * 3)
  }

  assert.strictEqual(mainRequests, changes.length * 6)
})
