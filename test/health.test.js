import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

import {
  setUpEnvironment,
  startICC
} from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('check that health is configured in runtime', async (t) => {
  const appName = 'test-health'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-health')

  const icc = await startICC(t, {
    applicationId
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = await app.watt.runtime.getRuntimeConfig()

  // Runtime applies its own defaults on top of ours, so we just verify health is enabled
  // and has expected properties
  assert.ok(runtimeConfig.health, 'Health configuration should be present')
  assert.strictEqual(runtimeConfig.health.enabled, true, 'Health monitoring should be enabled')
  assert.ok(runtimeConfig.health.interval, 'Health interval should be set')
  assert.ok(runtimeConfig.health.maxUnhealthyChecks, 'Health maxUnhealthyChecks should be set')
})

test('check that custom health configuration is not overridden', async (t) => {
  const appName = 'test-health-custom'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-health-custom')

  const icc = await startICC(t, {
    applicationId
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = await app.watt.runtime.getRuntimeConfig()

  assert.ok(runtimeConfig.health, 'Health configuration should be present')
  assert.strictEqual(runtimeConfig.health.enabled, true, 'Health monitoring should be enabled')
  assert.strictEqual(runtimeConfig.health.interval, 2500, 'Custom interval should be preserved')
  assert.strictEqual(runtimeConfig.health.maxUnhealthyChecks, 50, 'Custom maxUnhealthyChecks should be preserved')
})

test('should force health enabled and set defaults when app tries to disable it', async (t) => {
  const appName = 'test-health-disabled'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-health-disabled')

  const icc = await startICC(t, {
    applicationId
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = await app.watt.runtime.getRuntimeConfig()

  assert.ok(runtimeConfig.health, 'Health configuration should be present')
  assert.strictEqual(runtimeConfig.health.enabled, true, 'Health should be forced to enabled even if app config says false')
  assert.ok(runtimeConfig.health.interval, 'Health interval should be set')
  assert.ok(runtimeConfig.health.maxUnhealthyChecks, 'Health maxUnhealthyChecks should be set')

  // Wait for health events
  let healthEventReceived = false
  const eventName = app.watt.runtimeSupportsNewHealthMetrics()
    ? 'application:worker:health:metrics'
    : 'application:worker:health'

  app.watt.runtime.on(eventName, (healthInfo) => {
    healthEventReceived = true
  })

  // Wait up to 5 seconds for a health event
  const startTime = Date.now()
  /* eslint-disable no-unmodified-loop-condition */
  while (!healthEventReceived && (Date.now() - startTime) < 5000) {
    await setTimeout(100)
  }
  /* eslint-enable no-unmodified-loop-condition */

  assert.ok(healthEventReceived, 'Should receive health events since enabled is forced to true')
})
