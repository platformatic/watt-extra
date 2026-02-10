import assert from 'node:assert'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { randomUUID } from 'node:crypto'
import { request } from 'undici'
import { setUpEnvironment, startICC, installDeps } from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

test('should spawn a service app settings labels for metrics', async (t) => {
  const applicationName = 'test-application'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    enableOpenTelemetry: true,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const mainConfig = app.watt.runtime.getRuntimeConfig(true)

  const { metrics, telemetry } = mainConfig

  const expectedTelemetry = {
    enabled: true,
    applicationName: 'test-application',
    skip: [
      {
        method: 'GET',
        path: '/documentation',
      },
      {
        method: 'GET',
        path: '/documentation/json',
      },
    ],
    exporter: {
      type: 'otlp',
      options: {
        url: `${icc.iccUrl}/risk-service/v1/traces`,
        headers: {
          'x-platformatic-application-id': applicationId,
        },
        keepAlive: true,
        httpAgentOptions: {
          rejectUnauthorized: false,
        },
      },
    },
  }
  assert.deepStrictEqual(telemetry, expectedTelemetry)

  const expectedMetrics = {
    server: 'hide',
    defaultMetrics: {
      enabled: true,
    },
    hostname: '127.0.0.1',
    port: 9092,
    labels: {
      serviceId: 'main',
      instanceId: app.instanceId,
      applicationId,
    },
    applicationLabel: 'serviceId',
    httpCustomLabels: [
      { name: 'callerTelemetryId', header: 'x-plt-telemetry-id', default: '' }
    ]
  }
  assert.deepStrictEqual(metrics, expectedMetrics)
})

test('should remove server https configs', async (t) => {
  const appName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-service')

  await installDeps(t, applicationPath)

  const icc = await startICC(t, {
    applicationId,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:3002',
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  {
    const mainConfig = app.watt.runtime.getRuntimeConfig(true)
    const { server } = mainConfig
    assert.strictEqual(server.https, undefined)
  }

  {
    const runtimeConfig = await app.watt.runtime.getRuntimeConfig(true)

    const { server } = runtimeConfig
    assert.strictEqual(server.https, undefined)
  }
})

test('should configure health options', async (t) => {
  const appName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-service')

  await installDeps(t, applicationPath)

  const icc = await startICC(t, {
    applicationId,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = await app.watt.runtime.getRuntimeConfig(true)

  const { health } = runtimeConfig
  // Runtime applies its own defaults on top of ours, so we just verify health is configured
  assert.strictEqual(health.enabled, true)
  assert.ok(health.interval, 'Health interval should be set')
  assert.strictEqual(health.maxUnhealthyChecks, 10, 'Health maxUnhealthyChecks should have default value')
  assert.strictEqual(health.maxELU, 0.99, 'Health maxELU should have default value')
  assert.strictEqual(health.maxHeapUsed, 0.99, 'Health maxHeapUsed should have default value')
  assert.strictEqual(health.gracePeriod, 30000, 'Health gracePeriod should have default value')
})

test('should not set opentelemetry if it is disabled', async (t) => {
  const applicationName = 'test-application'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    enableOpenTelemetry: false,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  // main config
  const { statusCode, body } = await request('http://127.0.0.1:3043/config')
  assert.strictEqual(statusCode, 200)

  const expectedTelemetry = {
    enabled: false,
    applicationName: 'test-application-main',
    skip: [
      {
        method: 'GET',
        path: '/documentation',
      },
      {
        method: 'GET',
        path: '/documentation/json',
      },
    ],
    exporter: {
      type: 'otlp',
      options: {
        url: `${icc.iccUrl}/risk-service/v1/traces`,
        headers: {
          'x-platformatic-application-id': applicationId,
        },
        keepAlive: true,
        httpAgentOptions: {
          rejectUnauthorized: false,
        },
      },
    },
  }
  const mainConfig = await body.json()
  assert.deepStrictEqual(mainConfig.telemetry, expectedTelemetry)
})
test('should expose runtimeSupportsNewHealthMetrics method', async (t) => {
  const applicationName = 'test-application'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  assert.strictEqual(typeof app.watt.runtimeSupportsNewHealthMetrics, 'function', 'runtimeSupportsNewHealthMetrics should be a function')

  const supportsNewMetrics = app.watt.runtimeSupportsNewHealthMetrics()
  assert.strictEqual(typeof supportsNewMetrics, 'boolean', 'runtimeSupportsNewHealthMetrics should return a boolean')

  const runtimeVersion = app.watt.getRuntimeVersion()
  assert.ok(runtimeVersion, 'Runtime version should be available')
})

test('should expose getHealthConfig method', async (t) => {
  const applicationName = 'test-application'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: applicationName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  assert.strictEqual(typeof app.watt.getHealthConfig, 'function', 'getHealthConfig should be a function')

  const healthConfig = app.watt.getHealthConfig()
  assert.ok(healthConfig, 'Health config should be returned')
  assert.strictEqual(typeof healthConfig, 'object', 'Health config should be an object')
  assert.strictEqual(healthConfig.enabled, true, 'Health should be enabled')
  assert.ok(healthConfig.interval, 'Health config should have interval')
  assert.strictEqual(healthConfig.maxUnhealthyChecks, 10, 'Health config should have maxUnhealthyChecks default')
  assert.strictEqual(healthConfig.maxELU, 0.99, 'Health config should have maxELU default')
  assert.strictEqual(healthConfig.maxHeapUsed, 0.99, 'Health config should have maxHeapUsed default')
  assert.strictEqual(healthConfig.gracePeriod, 30000, 'Health config should have gracePeriod default')
})

test('should configure health based on runtime version', async (t) => {
  const appName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-service')

  await installDeps(t, applicationPath)

  const icc = await startICC(t, {
    applicationId,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = app.watt.runtime.getRuntimeConfig(true)
  const { health } = runtimeConfig

  // Health should always be enabled regardless of runtime version
  assert.strictEqual(health.enabled, true, 'Health should be enabled')

  const supportsNewMetrics = app.watt.runtimeSupportsNewHealthMetrics()

  if (supportsNewMetrics) {
    // For new runtime (>= 3.18.0), we only force enabled: true
    // Other values come from app config or runtime defaults
    assert.ok(health.interval, 'Health interval should be set')
    assert.ok(health.maxUnhealthyChecks, 'Health maxUnhealthyChecks should be set')
  } else {
    // For old runtime (< 3.18.0), we set specific defaults
    assert.ok(health.interval, 'Health interval should be set')
    assert.ok(health.maxUnhealthyChecks, 'Health maxUnhealthyChecks should be set')
  }
})

test('should merge user telemetry config with ICC exporter', async (t) => {
  const appName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-telemetry')

  await installDeps(t, applicationPath)

  const icc = await startICC(t, {
    applicationId,
    applicationName: appName,
    enableOpenTelemetry: true,
    port: 3001
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = app.watt.runtime.getRuntimeConfig(true)
  const { telemetry } = runtimeConfig

  // applicationName should be set to watt-extra app name (not user's custom name)
  assert.strictEqual(telemetry.applicationName, appName)

  // Exporter should be an array with both user's and ICC exporters
  assert.ok(Array.isArray(telemetry.exporter), 'Exporter should be an array when merging')
  assert.strictEqual(telemetry.exporter.length, 2)

  // First exporter should be user's Jaeger exporter
  const jaegerExporter = telemetry.exporter[0]
  assert.strictEqual(jaegerExporter.type, 'otlp')
  assert.strictEqual(jaegerExporter.options.url, 'http://jaeger:4318/v1/traces')

  // Second exporter should be ICC exporter
  const iccExporter = telemetry.exporter[1]
  assert.strictEqual(iccExporter.type, 'otlp')
  assert.ok(iccExporter.options.url.includes('/risk-service/v1/traces'))
  assert.strictEqual(iccExporter.options.headers['x-platformatic-application-id'], applicationId)

  // Skip patterns should be merged
  assert.ok(Array.isArray(telemetry.skip))
  const hasUserSkip = telemetry.skip.some(s => s.path === '/health')
  const hasDefaultSkip = telemetry.skip.some(s => s.path === '/documentation')
  assert.ok(hasUserSkip, 'User skip pattern should be preserved')
  assert.ok(hasDefaultSkip, 'Default skip pattern should be added')
})

test('should configure next service with cache', async (t) => {
  const appName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-next')
  const nextServicePath = join(applicationPath, 'web', 'next')

  await installDeps(t, applicationPath)
  await installDeps(t, nextServicePath, ['@platformatic/next', 'next'])

  const { execa } = await import('execa')
  await execa(join(__dirname, '../node_modules/.bin/plt'), ['build'], {
    cwd: applicationPath,
  })

  const icc = await startICC(t, {
    applicationId,
    port: 3001,
    controlPlaneResponse: {
      applicationId,
      httpCache: {
        clientOpts: {
          keyPrefix: 'test-prefix',
          host: '127.0.0.1',
          port: 6379,
          username: 'user',
          password: 'pass'
        }
      }
    }
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_APP_PORT: 3043,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = app.watt.runtime.getRuntimeConfig(true)
  const nextApp = runtimeConfig.applications.find(a => a.type === '@platformatic/next')
  assert.ok(nextApp, 'Next service should be found in applications')

  const nextConfig = await app.watt.runtime.getApplicationConfig(nextApp.id)
  assert.ok(nextConfig.cache, 'Cache should be configured for next service')
  assert.strictEqual(nextConfig.cache.adapter, 'valkey')
  assert.strictEqual(nextConfig.cache.prefix, 'test-prefix')
  assert.strictEqual(nextConfig.cache.maxTTL, 604800)
})
