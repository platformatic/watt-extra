import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { start } from '../index.js'
import { setUpEnvironment, startICC } from './helper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The runtime reports a Next.js application as '@platformatic/next' (older
// runtimes said 'next'). The Next patches, cache adapter included, must be
// applied in both cases: the fixture must be built first (wattpm build).
test('should configure the Next.js cache adapter for @platformatic/next applications', async (t) => {
  const applicationName = 'test-next'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-next')
  const clientOpts = {
    host: '127.0.0.1',
    port: 6379,
    username: 'cache-user',
    password: 'cache-pass',
    keyPrefix: `${applicationId}:`
  }

  const icc = await startICC(t, {
    applicationId,
    applicationName,
    controlPlaneResponse: {
      applicationId,
      applicationName,
      deploymentVersion: 'v-next',
      enableOpenTelemetry: false,
      iccServices: {},
      httpCache: { clientOpts },
      config: {}
    },
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

  const runtimeConfig = app.watt.runtime.getRuntimeConfig(true)
  const nextApplication = runtimeConfig.applications.find((application) => application.id === 'next')
  assert.strictEqual(nextApplication.type, '@platformatic/next')

  const nextConfig = await app.watt.runtime.getApplicationConfig('next')
  assert.deepStrictEqual(nextConfig.cache, {
    adapter: 'valkey',
    url: 'valkey://cache-user:cache-pass@127.0.0.1:6379',
    prefix: `${applicationId}:`,
    maxTTL: 604800
  })
})
