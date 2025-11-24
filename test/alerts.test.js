import assert from 'node:assert'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Profile } from 'pprof-format'
import { setUpEnvironment, startICC } from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function emitHealthEvent (app, healthInfo) {
  if (app.watt.runtimeSupportsNewHealthMetrics()) {
    if (!healthInfo) {
      // Emit null for testing error handling
      app.watt.runtime.emit('application:worker:health:metrics', null)
      return
    }
    // Runtime >= 3.18.0: emit health:metrics event with real event shape
    const { id, application, currentHealth } = healthInfo

    // Add currentELU to match real event shape
    const enrichedCurrentHealth = {
      ...currentHealth,
      currentELU: {
        idle: 1000,
        active: currentHealth.elu * 1000,
        utilization: currentHealth.elu
      }
    }

    app.watt.runtime.emit('application:worker:health:metrics', {
      id,
      application,
      worker: 0,
      currentHealth: enrichedCurrentHealth,
      healthSignals: []
    })
  } else {
    // Runtime < 3.18.0: emit health event with full healthInfo
    app.watt.runtime.emit('application:worker:health', healthInfo)
  }
}

test('should send alert when service becomes unhealthy', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null
  let flamegraphReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    },
    processFlamegraphs: (req) => {
      const alertId = req.query.alertId
      assert.strictEqual(alertId, 'test-alert-id')
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      flamegraphReceived = req.body
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

  // Manually trigger health event with unhealthy state
  const healthInfo = {
    id: 'main:0',
    application: 'main',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, healthInfo)

  await sleep(200)

  assert.ok(alertReceived, 'Alert should have been received')
  assert.strictEqual(alertReceived.applicationId, applicationId)
  assert.strictEqual(alertReceived.alert.id, healthInfo.id)
  assert.strictEqual(alertReceived.alert.application, 'main')
  assert.strictEqual(alertReceived.alert.service, 'main')
  assert.strictEqual(alertReceived.alert.unhealthy, true)
  assert.strictEqual(alertReceived.alert.currentHealth.elu, healthInfo.currentHealth.elu)
  assert.strictEqual(alertReceived.alert.currentHealth.heapUsed, healthInfo.currentHealth.heapUsed)
  assert.strictEqual(alertReceived.alert.currentHealth.heapTotal, healthInfo.currentHealth.heapTotal)
  assert.strictEqual(alertReceived.alert.healthConfig, undefined, 'healthConfig should be deleted from alert')
  assert.ok(Array.isArray(alertReceived.healthHistory), 'Health history should be an array')
  assert.ok(alertReceived.healthHistory.length > 0, 'Health history should not be empty')
  assert.strictEqual(alertReceived.healthHistory[0].application, 'main')
  assert.strictEqual(alertReceived.healthHistory[0].service, 'main')

  assert.ok(flamegraphReceived, 'Flamegraph should have been received')

  const profile = Profile.decode(flamegraphReceived)
  assert.ok(profile, 'Profile should be decoded')
})

test('should not send alert when application is healthy', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // Manually trigger health event with healthy state
  const healthInfo = {
    id: 'service-1',
    application: 'service-1',
    currentHealth: {
      elu: 0.5,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: false,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, healthInfo)

  await sleep(200)

  // Verify no alert was sent
  assert.strictEqual(alertReceived, null, 'No alert should have been received')
})

test('should cache health data and include it in alerts', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_ALERT_CACHE_WINDOW: '2000' // 2 seconds for faster testing
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // Send 3 healthy events first
  for (let i = 0; i < 3; i++) {
    const healthyInfo = {
      id: 'service-1',
      application: 'service-1',
      currentHealth: {
        elu: 0.5 + (i * 0.1), // Different values to distinguish them
        heapUsed: 76798040,
        heapTotal: 99721216
      },
      unhealthy: false,
      healthConfig: {
        enabled: true,
        interval: 1000,
        gracePeriod: 1000,
        maxUnhealthyChecks: 10,
        maxELU: 0.99,
        maxHeapUsed: 0.99,
        maxHeapTotal: 4294967296
      }
    }

    emitHealthEvent(app, healthyInfo)
    await sleep(100) // Small delay between events
  }

  // Now send an unhealthy event to trigger alert
  const unhealthyInfo = {
    id: 'service-1',
    application: 'service-1',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, unhealthyInfo)
  await sleep(200)

  assert.ok(alertReceived, 'Alert should have been received')
  assert.strictEqual(alertReceived.applicationId, applicationId)

  assert.strictEqual(alertReceived.alert.id, unhealthyInfo.id)
  assert.strictEqual(alertReceived.alert.application, 'service-1')
  assert.strictEqual(alertReceived.alert.service, 'service-1')
  assert.strictEqual(alertReceived.alert.unhealthy, unhealthyInfo.unhealthy)

  assert.ok(Array.isArray(alertReceived.healthHistory), 'Health history should be an array')
  assert.ok(alertReceived.healthHistory.length >= 4, 'Should contain at least our 4 health events')

  for (const entry of alertReceived.healthHistory) {
    assert.ok('unhealthy' in entry, 'Entry should have unhealthy property')
    assert.ok('currentHealth' in entry, 'Entry should have currentHealth property')
    assert.ok('timestamp' in entry, 'Entry should have timestamp property')
    assert.ok('service' in entry, 'Entry should have service property')
    assert.ok('application' in entry, 'Entry should have application property')
    assert.strictEqual(entry.service, entry.application, 'service should match application')
    assert.ok(!('healthConfig' in entry), 'Entry should not have healthConfig property')
  }

  assert.strictEqual(alertReceived.healthHistory[alertReceived.healthHistory.length - 1].unhealthy, true, 'Last event should be unhealthy')

  let healthyCount = 0
  for (const entry of alertReceived.healthHistory) {
    if (!entry.unhealthy) healthyCount++
  }
  assert.ok(healthyCount >= 3, 'Should contain at least 3 healthy events')
})

test('should not fail when health info is missing', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  emitHealthEvent(app, null)

  await sleep(200)

  assert.strictEqual(alertReceived, null, 'No alert should have been received')
})

test('should respect alert retention window', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const alertsReceived = []

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    scaler: {
      alertRetentionWindow: 500
    },
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertsReceived.push(alert)
      return { id: 'test-alert-id', ...alert }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()

  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // Create a health info template
  const createHealthInfo = (applicationId, unhealthy = true) => ({
    id: applicationId,
    application: applicationId,
    currentHealth: {
      elu: unhealthy ? 0.995 : 0.5,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  })

  // Send first unhealthy event - should trigger alert
  emitHealthEvent(app, createHealthInfo('service-1', true))
  await sleep(50)

  // Send second unhealthy event immediately - should trigger alert
  emitHealthEvent(app, createHealthInfo('service-2', true))
  await sleep(50)

  // Send second unhealthy event immediately - should be ignored due to retention window
  emitHealthEvent(app, createHealthInfo('service-1', true))
  await sleep(100)

  assert.strictEqual(alertsReceived.length, 2, 'Only one alert should be sent within retention window')

  await sleep(500)

  // Send third unhealthy event - should trigger second alert
  emitHealthEvent(app, createHealthInfo('service-1', true))
  await sleep(100)

  assert.strictEqual(alertsReceived.length, 3, 'Second alert should be sent after retention window expires')
})

test('should not set up alerts when scaler URL is missing', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    iccServices: {} // No data scaler URL
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

  const warnings = []
  const originalWarn = app.log.warn
  app.log.warn = function (message) {
    warnings.push(typeof message === 'string' ? message : JSON.stringify(message))
    return originalWarn.apply(this, arguments)
  }

  await app.setupAlerts()

  // Verify warning about missing scaler URL
  const hasWarning = warnings.some(warning =>
    warning.includes('No scaler URL found in ICC services, health alerts disabled')
  )
  assert.ok(hasWarning, 'Should log warning about missing scaler URL')
})

test('should send alert when flamegraphs are disabled', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: true,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 2
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  await sleep(5000)

  // Manually trigger health event with unhealthy state
  const healthInfo = {
    id: 'main:0',
    application: 'main',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, healthInfo)

  await sleep(200)

  assert.ok(alertReceived, 'Alert should have been received')
  assert.strictEqual(alertReceived.applicationId, applicationId)
  assert.strictEqual(alertReceived.alert.id, healthInfo.id)
  assert.strictEqual(alertReceived.alert.application, 'main')
  assert.strictEqual(alertReceived.alert.service, 'main')
  assert.strictEqual(alertReceived.alert.unhealthy, true)
  assert.strictEqual(alertReceived.alert.currentHealth.elu, healthInfo.currentHealth.elu)
  assert.strictEqual(alertReceived.alert.currentHealth.heapUsed, healthInfo.currentHealth.heapUsed)
  assert.strictEqual(alertReceived.alert.currentHealth.heapTotal, healthInfo.currentHealth.heapTotal)
  assert.strictEqual(alertReceived.alert.healthConfig, undefined, 'healthConfig should be deleted from alert')
  assert.ok(Array.isArray(alertReceived.healthHistory), 'Health history should be an array')
  assert.ok(alertReceived.healthHistory.length > 0, 'Health history should not be empty')
  assert.strictEqual(alertReceived.healthHistory[0].application, 'main')
  assert.strictEqual(alertReceived.healthHistory[0].service, 'main')
  assert.equal(alertReceived.flamegraph, null, 'Flamegraph should be null')
})

test('should send alert when failed to send a flamegraph', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    },
    processFlamegraphs: ({ alertId, flamegraph }) => {
      throw new Error('Failed to send flamegraph')
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 2
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  await sleep(5000)

  // Manually trigger health event with unhealthy state
  const healthInfo = {
    id: 'main:0',
    application: 'main',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, healthInfo)

  await sleep(200)

  assert.ok(alertReceived, 'Alert should have been received')
  assert.strictEqual(alertReceived.applicationId, applicationId)
  assert.strictEqual(alertReceived.alert.id, healthInfo.id)
  assert.strictEqual(alertReceived.alert.application, 'main')
  assert.strictEqual(alertReceived.alert.service, 'main')
  assert.strictEqual(alertReceived.alert.unhealthy, true)
  assert.strictEqual(alertReceived.alert.currentHealth.elu, healthInfo.currentHealth.elu)
  assert.strictEqual(alertReceived.alert.currentHealth.heapUsed, healthInfo.currentHealth.heapUsed)
  assert.strictEqual(alertReceived.alert.currentHealth.heapTotal, healthInfo.currentHealth.heapTotal)
  assert.strictEqual(alertReceived.alert.healthConfig, undefined, 'healthConfig should be deleted from alert')
  assert.ok(Array.isArray(alertReceived.healthHistory), 'Health history should be an array')
  assert.ok(alertReceived.healthHistory.length > 0, 'Health history should not be empty')
  assert.strictEqual(alertReceived.healthHistory[0].application, 'main')
  assert.strictEqual(alertReceived.healthHistory[0].service, 'main')
  assert.equal(alertReceived.flamegraph, null, 'Flamegraph should be null')
})

test('should handle old runtime (< 3.18.0) health events', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  let alertReceived = null

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    processAlerts: (req) => {
      const alert = req.body
      assert.equal(req.headers.authorization, 'Bearer test-token')
      alertReceived = alert
      return { id: 'test-alert-id', ...alert }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000'
  })

  const app = await start()
  app.getAuthorizationHeader = getAuthorizationHeader

  // Mock the runtime version check to simulate old runtime
  const originalFn = app.watt.runtimeSupportsNewHealthMetrics
  app.watt.runtimeSupportsNewHealthMetrics = () => false

  // Remove all existing event listeners
  app.watt.runtime.removeAllListeners('application:worker:health:metrics')
  app.watt.runtime.removeAllListeners('application:worker:health')

  // Re-setup alerts with the mocked function (will use old path)
  await app.setupAlerts()

  t.after(async () => {
    app.watt.runtimeSupportsNewHealthMetrics = originalFn
    await app.close()
    await icc.close()
  })

  // Manually trigger health event with unhealthy state using old event format
  const healthInfo = {
    id: 'main:0',
    application: 'main',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  // Emit using old event format (application:worker:health)
  app.watt.runtime.emit('application:worker:health', healthInfo)

  await sleep(200)

  assert.ok(alertReceived, 'Alert should have been received')
  assert.strictEqual(alertReceived.applicationId, applicationId)
  assert.strictEqual(alertReceived.alert.id, healthInfo.id)
  assert.strictEqual(alertReceived.alert.application, 'main')
  assert.strictEqual(alertReceived.alert.service, 'main')
  assert.strictEqual(alertReceived.alert.unhealthy, true)
  assert.deepStrictEqual(alertReceived.alert.currentHealth, healthInfo.currentHealth)
  assert.strictEqual(alertReceived.alert.healthConfig, undefined, 'healthConfig should be deleted from alert')
})

test('should attach one flamegraph to multiple alerts', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const receivedAlerts = []
  const receivedFlamegraphs = []
  const receivedAttachedFlamegraphs = []

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    scaler: {
      podHealthWindow: 1,
      alertRetentionWindow: 1
    },
    processAlerts: (req) => {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      const alert = req.body
      alert.id = `alert-${receivedAlerts.length + 1}`
      receivedAlerts.push(alert)
      return alert
    },
    processFlamegraphs: (req) => {
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      const flamegraphId = `flamegraph-${receivedFlamegraphs.length + 1}`
      const alertId = req.query.alertId
      receivedFlamegraphs.push({ id: flamegraphId, alertId })
      return { id: flamegraphId }
    },
    attachFlamegraphToAlerts: (req) => {
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      const flamegraphId = req.params.flamegraphId
      const { alertIds } = req.body
      receivedAttachedFlamegraphs.push({ flamegraphId, alertIds })
      return {}
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 5,
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

  // Manually trigger health event with unhealthy state
  const healthInfo = {
    id: 'main:0',
    application: 'main',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, healthInfo)
  await sleep(1000)
  emitHealthEvent(app, healthInfo)

  // Wait for flamegraphs to be sent
  await sleep(1000)

  assert.strictEqual(receivedAlerts.length, 2)
  const alert1 = receivedAlerts[0]
  const alert2 = receivedAlerts[1]
  assert.strictEqual(alert1.id, 'alert-1')
  assert.strictEqual(alert2.id, 'alert-2')

  assert.strictEqual(receivedFlamegraphs.length, 1)
  const flamegraph = receivedFlamegraphs[0]
  assert.strictEqual(flamegraph.id, 'flamegraph-1')
  assert.strictEqual(flamegraph.alertId, 'alert-1')

  assert.strictEqual(receivedAttachedFlamegraphs.length, 1)
  const attachedFlamegraph = receivedAttachedFlamegraphs[0]
  assert.strictEqual(attachedFlamegraph.flamegraphId, 'flamegraph-1')
  assert.deepStrictEqual(attachedFlamegraph.alertIds, ['alert-2'])
})

test('should send flamegraphs if attaching fails', async (t) => {
  const applicationName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const receivedAlerts = []
  const receivedFlamegraphs = []

  const getAuthorizationHeader = async (headers) => {
    return { ...headers, authorization: 'Bearer test-token' }
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    scaler: {
      podHealthWindow: 1,
      alertRetentionWindow: 1
    },
    processAlerts: (req) => {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      const alert = req.body
      alert.id = `alert-${receivedAlerts.length + 1}`
      receivedAlerts.push(alert)
      return alert
    },
    processFlamegraphs: (req) => {
      assert.strictEqual(req.headers.authorization, 'Bearer test-token')
      const flamegraphId = `flamegraph-${receivedFlamegraphs.length + 1}`
      const alertId = req.query.alertId
      receivedFlamegraphs.push({ id: flamegraphId, alertId })
      return { id: flamegraphId }
    },
    attachFlamegraphToAlerts: (req) => {
      throw new Error('Failed to attach flamegraph')
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_DISABLE_FLAMEGRAPHS: false,
    PLT_FLAMEGRAPHS_INTERVAL_SEC: 5,
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

  // Manually trigger health event with unhealthy state
  const healthInfo = {
    id: 'main:0',
    application: 'main',
    currentHealth: {
      elu: 0.995,
      heapUsed: 76798040,
      heapTotal: 99721216
    },
    unhealthy: true,
    healthConfig: {
      enabled: true,
      interval: 1000,
      gracePeriod: 1000,
      maxUnhealthyChecks: 10,
      maxELU: 0.99,
      maxHeapUsed: 0.99,
      maxHeapTotal: 4294967296
    }
  }

  emitHealthEvent(app, healthInfo)
  await sleep(1000)
  emitHealthEvent(app, healthInfo)

  // Wait for flamegraphs to be sent
  await sleep(1000)

  assert.strictEqual(receivedAlerts.length, 2)
  const alert1 = receivedAlerts[0]
  const alert2 = receivedAlerts[1]
  assert.strictEqual(alert1.id, 'alert-1')
  assert.strictEqual(alert2.id, 'alert-2')

  assert.strictEqual(receivedFlamegraphs.length, 2)
  const flamegraph1 = receivedFlamegraphs[0]
  assert.strictEqual(flamegraph1.id, 'flamegraph-1')
  assert.strictEqual(flamegraph1.alertId, 'alert-1')

  const flamegraph2 = receivedFlamegraphs[1]
  assert.strictEqual(flamegraph2.id, 'flamegraph-2')
  assert.strictEqual(flamegraph2.alertId, 'alert-2')
})
