import assert from 'node:assert'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import Watt from '../lib/watt.js'

import { randomUUID } from 'node:crypto'
import { start } from './runtime.js'
import {
  setUpEnvironment,
  startICC,
  installDeps
} from './helper.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('ICC jobs start paused without post-start pausing and remain manually executable', async (t) => {
  // Prove autostart alone prevents execution, without the post-start fallback.
  t.mock.method(Watt.prototype, 'applySchedulerMode', async () => {})
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-scheduler')

  await installDeps(t, applicationPath)

  let savedWattJob = null
  const icc = await startICC(t, {
    applicationId,
    applicationName,
    saveWattJob: (job) => {
      savedWattJob = job
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })
  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const jobs = await app.watt.runtime.getSchedulerJobs()
  assert.strictEqual(app.watt.runtime.getRuntimeConfig().scheduler.autostart, false)
  assert.strictEqual(jobs.length, 1)
  assert.strictEqual(jobs[0].paused, true)

  // ICC is called to save the job
  const expectedWattJob = {
    name: 'main:0',
    source: 'application',
    scheduleId: '0',
    tasks: ['test'],
    schedule: '* * * * * *',
    maxRetries: 3,
    applicationId
  }
  assert.deepEqual(savedWattJob, expectedWattJob)
  await setTimeout(1500)
  const before = await app.watt.runtime.inject('main', { method: 'GET', url: '/executions' })
  assert.deepStrictEqual(JSON.parse(before.body), { executions: 0 })
  await app.runScheduledJob({ name: jobs[0].name })
  const response = await app.watt.runtime.inject('main', { method: 'GET', url: '/executions' })
  assert.deepStrictEqual(JSON.parse(response.body), { executions: 1 })
})

test('without ICC the runtime starts and executes local schedules', async t => {
  setUpEnvironment({
    PLT_APP_NAME: 'local-scheduler',
    PLT_APP_DIR: join(__dirname, 'fixtures', 'runtime-scheduler'),
    PLT_ICC_URL: ''
  })
  const app = await start()
  t.after(() => app.close())
  const jobs = await app.watt.runtime.getSchedulerJobs()
  assert.strictEqual(jobs.length, 1)
  assert.strictEqual(jobs[0].paused, false)
  await setTimeout(1500)
  const response = await app.watt.runtime.inject('main', { method: 'GET', url: '/executions' })
  assert.ok(JSON.parse(response.body).executions > 0)
})
