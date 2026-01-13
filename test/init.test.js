import { test } from 'node:test'
import { equal } from 'node:assert'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startICC } from './helper.js'
import initPlugin from '../plugins/init.js'

const createMockApp = (env = {}) => {
  const logMessages = []
  return {
    env: {
      PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:3000/control-plane',
      PLT_ICC_URL: 'http://127.0.0.1:3000',
      ...env
    },
    log: {
      info: (msg) => {
        logMessages.push(msg)
      },
      warn: () => {},
      error: () => {}
    },
    getAuthorizationHeader: async () => 'Bearer test-token',
    logMessages
  }
}

test('init plugin with explicit PLT_APP_NAME', async (t) => {
  const applicationName = 'test-app-explicit'
  const applicationId = randomUUID()
  const instanceId = hostname()

  const icc = await startICC(t, {
    applicationId,
    applicationName
  })

  t.after(async () => {
    await icc.close()
  })

  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir'
  })

  await initPlugin(app)

  equal(app.applicationName, applicationName)
  equal(app.instanceId, instanceId)
  equal(app.instanceConfig.applicationId, applicationId)
})

test('init plugin with optional PLT_APP_NAME - uses ICC response', async (t) => {
  const applicationName = 'test-app-from-icc'
  const applicationId = randomUUID()
  const instanceId = hostname()

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: {
      applicationId,
      applicationName, // ICC returns the application name
      iccServices: {
        riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
        trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
        compliance: { url: 'http://127.0.0.1:3000/compliance' },
        cron: { url: 'http://127.0.0.1:3000/cron' },
        scaler: { url: 'http://127.0.0.1:3000/scaler' }
      },
      config: {},
      enableOpenTelemetry: false,
      enableSlicerInterceptor: false,
      enableTrafficInterceptor: false
    }
  })

  t.after(async () => {
    await icc.close()
  })

  const app = createMockApp({
    // PLT_APP_NAME is not set
    PLT_APP_DIR: '/test/dir'
  })

  await initPlugin(app)

  equal(app.applicationName, applicationName)
  equal(app.instanceId, instanceId)
  equal(app.instanceConfig.applicationId, applicationId)

  // Check that logging shows the resolved application name
  const resolvedNameLog = app.logMessages.find(msg =>
    typeof msg === 'object' && msg.applicationName === applicationName
  )
  equal(!!resolvedNameLog, true)
})

test('init plugin in standalone mode - no ICC URL', async (t) => {
  const applicationName = 'test-app-standalone'
  const instanceId = hostname()

  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir',
    PLT_ICC_URL: undefined // No ICC URL set
  })

  await initPlugin(app)

  equal(app.applicationName, applicationName)
  equal(app.instanceId, instanceId)
  equal(app.instanceConfig, null)

  // Check that logging shows ICC initialization was skipped
  const skipLog = app.logMessages.find(msg =>
    typeof msg === 'string' && msg.includes('skipping ICC initialization')
  )
  equal(!!skipLog, true)
})

test('init plugin handles ICC connection failure gracefully', async (t) => {
  const applicationName = 'test-app-failure'
  const instanceId = hostname()

  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir',
    PLT_ICC_URL: 'http://127.0.0.1:9999' // Non-existent ICC
  })

  // Override error logging to capture errors
  const errorMessages = []
  app.log.error = (err, msg) => {
    errorMessages.push({ err, msg })
  }

  await initPlugin(app)

  // Should still set applicationName and instanceId
  equal(app.applicationName, applicationName)
  equal(app.instanceId, instanceId)

  // Should have logged an error
  equal(errorMessages.length, 1)
  equal(errorMessages[0].msg, 'Failed to get application information')
})

test('init plugin sends correct request structure when PLT_APP_NAME provided', async (t) => {
  const applicationName = 'test-app-request'
  const applicationId = randomUUID()
  const instanceId = hostname()

  let capturedRequest = null

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: (req) => {
      capturedRequest = {
        params: req.params,
        body: req.body
      }
      return {
        applicationId,
        applicationName,
        iccServices: {
          riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
          trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
          compliance: { url: 'http://127.0.0.1:3000/compliance' },
          cron: { url: 'http://127.0.0.1:3000/cron' },
          scaler: { url: 'http://127.0.0.1:3000/scaler' }
        },
        config: {}
      }
    }
  })

  t.after(async () => {
    await icc.close()
  })

  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir'
  })

  await initPlugin(app)

  // Verify request structure
  equal(capturedRequest.params.podId, instanceId)
  equal(capturedRequest.body.applicationName, applicationName)
  equal(capturedRequest.body.podId, instanceId)
  equal(capturedRequest.body.apiVersion, 'v3')
})

test('init plugin sends request without applicationName when not provided', async (t) => {
  const applicationName = 'test-app-no-name'
  const applicationId = randomUUID()
  const instanceId = hostname()

  let capturedRequest = null

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: (req) => {
      capturedRequest = {
        params: req.params,
        body: req.body
      }
      return {
        applicationId,
        applicationName, // ICC provides the name
        iccServices: {
          riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
          trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
          compliance: { url: 'http://127.0.0.1:3000/compliance' },
          cron: { url: 'http://127.0.0.1:3000/cron' },
          scaler: { url: 'http://127.0.0.1:3000/scaler' }
        },
        config: {}
      }
    }
  })

  t.after(async () => {
    await icc.close()
  })

  const app = createMockApp({
    // PLT_APP_NAME is not provided
    PLT_APP_DIR: '/test/dir'
  })

  await initPlugin(app)

  // Verify request structure - should not contain applicationName
  equal(capturedRequest.params.podId, instanceId)
  equal(capturedRequest.body.podId, instanceId)
  equal(capturedRequest.body.applicationName, undefined)
  equal(capturedRequest.body.apiVersion, 'v3')

  // But app should have the name from ICC response
  equal(app.applicationName, applicationName)
})

test('init plugin calls updateInstanceConfig on watt when ICC becomes available after startup', async (t) => {
  const applicationName = 'test-app-recovery'
  const applicationId = randomUUID()
  const instanceId = hostname()

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: {
      applicationId,
      applicationName,
      iccServices: {
        riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
        trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
        compliance: { url: 'http://127.0.0.1:3000/compliance' },
        cron: { url: 'http://127.0.0.1:3000/cron' },
        scaler: { url: 'http://127.0.0.1:3000/scaler' }
      },
      config: {},
      enableSlicerInterceptor: true,
      enableTrafficInterceptor: false
    }
  })

  t.after(async () => {
    await icc.close()
  })

  // First, simulate initial startup with ICC unavailable
  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir',
    PLT_ICC_URL: 'http://127.0.0.1:9999', // Non-existent ICC initially
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:9999/control-plane' // Also non-existent
  })

  app.log.error = () => {} // Suppress error log for initial failure

  await initPlugin(app)

  // Verify initial state - instanceConfig should be null, watt should exist
  equal(app.instanceConfig, null)
  equal(typeof app.watt, 'object')
  equal(typeof app.initApplication, 'function')

  // Track if updateInstanceConfig was called
  let updateInstanceConfigCalled = false
  let receivedInstanceConfig = null
  app.watt.updateInstanceConfig = async (config) => {
    updateInstanceConfigCalled = true
    receivedInstanceConfig = config
  }

  // Now simulate ICC becoming available - update the URL and call initApplication
  app.env.PLT_ICC_URL = `http://127.0.0.1:${icc.server.address().port}`
  app.env.PLT_CONTROL_PLANE_URL = `http://127.0.0.1:${icc.server.address().port}/control-plane`

  await app.initApplication()

  // Verify updateInstanceConfig was called with the new config
  equal(updateInstanceConfigCalled, true)
  equal(receivedInstanceConfig.applicationId, applicationId)
  equal(app.instanceConfig.applicationId, applicationId)
  equal(app.instanceId, instanceId)
})

test('updateInstanceConfig calls runtime.updateMetricsConfig with merged config', async (t) => {
  const applicationName = 'test-app-metrics'
  const applicationId = randomUUID()
  const applicationMetricsLabel = 'customLabel'

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: {
      applicationId,
      applicationName,
      applicationMetricsLabel,
      iccServices: {
        riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
        trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
        compliance: { url: 'http://127.0.0.1:3000/compliance' },
        cron: { url: 'http://127.0.0.1:3000/cron' },
        scaler: { url: 'http://127.0.0.1:3000/scaler' }
      },
      config: {}
    }
  })

  t.after(async () => {
    await icc.close()
  })

  // First, simulate initial startup with ICC unavailable
  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir',
    PLT_ICC_URL: 'http://127.0.0.1:9999',
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:9999/control-plane'
  })

  app.log.error = () => {}

  await initPlugin(app)

  // Mock the runtime with current metrics config (as set by #configureRuntime)
  const currentMetricsConfig = {
    server: 'hide',
    defaultMetrics: { enabled: true },
    hostname: '0.0.0.0',
    port: 9090,
    labels: {
      serviceId: 'main',
      instanceId: hostname()
    },
    applicationLabel: 'serviceId'
  }

  let updateMetricsConfigCalled = false
  let receivedMetricsConfig = null

  app.watt.runtime = {
    getRuntimeConfig: () => ({ metrics: currentMetricsConfig }),
    updateMetricsConfig: async (config) => {
      updateMetricsConfigCalled = true
      receivedMetricsConfig = config
    },
    updateUndiciInterceptors: async () => {}
  }

  // Now simulate ICC becoming available
  app.env.PLT_ICC_URL = `http://127.0.0.1:${icc.server.address().port}`
  app.env.PLT_CONTROL_PLANE_URL = `http://127.0.0.1:${icc.server.address().port}/control-plane`

  await app.initApplication()

  // Verify updateMetricsConfig was called with merged config
  equal(updateMetricsConfigCalled, true)
  equal(receivedMetricsConfig.server, 'hide')
  equal(receivedMetricsConfig.port, 9090)
  equal(receivedMetricsConfig.labels.serviceId, 'main')
  equal(receivedMetricsConfig.labels.instanceId, hostname())
  equal(receivedMetricsConfig.labels.applicationId, applicationId)
  equal(receivedMetricsConfig.applicationLabel, applicationMetricsLabel)
})

test('updateInstanceConfig does not fail when runtime does not support updateMetricsConfig', async (t) => {
  const applicationName = 'test-app-no-metrics-support'
  const applicationId = randomUUID()

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: {
      applicationId,
      applicationName,
      iccServices: {
        riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
        trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
        compliance: { url: 'http://127.0.0.1:3000/compliance' },
        cron: { url: 'http://127.0.0.1:3000/cron' },
        scaler: { url: 'http://127.0.0.1:3000/scaler' }
      },
      config: {}
    }
  })

  t.after(async () => {
    await icc.close()
  })

  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir',
    PLT_ICC_URL: 'http://127.0.0.1:9999',
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:9999/control-plane'
  })

  app.log.error = () => {}

  await initPlugin(app)

  // Mock runtime WITHOUT updateMetricsConfig (old runtime)
  app.watt.runtime = {
    getRuntimeConfig: () => ({ metrics: {} }),
    updateUndiciInterceptors: async () => {}
    // Note: no updateMetricsConfig method
  }

  app.env.PLT_ICC_URL = `http://127.0.0.1:${icc.server.address().port}`
  app.env.PLT_CONTROL_PLANE_URL = `http://127.0.0.1:${icc.server.address().port}/control-plane`

  // Should not throw
  await app.initApplication()

  // Verify instanceConfig was still updated
  equal(app.instanceConfig.applicationId, applicationId)
})

test('updateInstanceConfig preserves existing applicationLabel when ICC does not provide one', async (t) => {
  const applicationName = 'test-app-preserve-label'
  const applicationId = randomUUID()

  const icc = await startICC(t, {
    applicationId,
    controlPlaneResponse: {
      applicationId,
      applicationName,
      // Note: no applicationMetricsLabel provided
      iccServices: {
        riskEngine: { url: 'http://127.0.0.1:3000/risk-service' },
        trafficInspector: { url: 'http://127.0.0.1:3000/traffic-inspector' },
        compliance: { url: 'http://127.0.0.1:3000/compliance' },
        cron: { url: 'http://127.0.0.1:3000/cron' },
        scaler: { url: 'http://127.0.0.1:3000/scaler' }
      },
      config: {}
    }
  })

  t.after(async () => {
    await icc.close()
  })

  const app = createMockApp({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: '/test/dir',
    PLT_ICC_URL: 'http://127.0.0.1:9999',
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:9999/control-plane'
  })

  app.log.error = () => {}

  await initPlugin(app)

  const currentMetricsConfig = {
    labels: { serviceId: 'main', instanceId: hostname() },
    applicationLabel: 'serviceId'
  }

  let receivedMetricsConfig = null

  app.watt.runtime = {
    getRuntimeConfig: () => ({ metrics: currentMetricsConfig }),
    updateMetricsConfig: async (config) => {
      receivedMetricsConfig = config
    },
    updateUndiciInterceptors: async () => {}
  }

  app.env.PLT_ICC_URL = `http://127.0.0.1:${icc.server.address().port}`
  app.env.PLT_CONTROL_PLANE_URL = `http://127.0.0.1:${icc.server.address().port}/control-plane`

  await app.initApplication()

  // Should preserve existing applicationLabel since ICC didn't provide one
  equal(receivedMetricsConfig.applicationLabel, 'serviceId')
  equal(receivedMetricsConfig.labels.applicationId, applicationId)
})
