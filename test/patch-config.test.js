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
        url: 'http://127.0.0.1:3000/risk-service/v1/traces',
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
    port: 9090,
    labels: {
      serviceId: 'main',
      instanceId: app.instanceId,
      applicationId,
    },
    applicationLabel: 'serviceId'
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
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:3002',
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
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: 'http://127.0.0.1:3000',
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const runtimeConfig = await app.watt.runtime.getRuntimeConfig(true)

  const { health } = runtimeConfig
  assert.strictEqual(health.enabled, true)
  assert.strictEqual(health.interval, 1000)
  assert.strictEqual(health.maxUnhealthyChecks, 30)
})

test('should not set opentelemetry if it is disabled', async (t) => {
  const applicationName = 'test-application'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'service-1')

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    enableOpenTelemetry: false,
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

  // main config
  const { statusCode, body } = await request('http://127.0.0.1:3042/config')
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
        url: 'http://127.0.0.1:3000/risk-service/v1/traces',
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
