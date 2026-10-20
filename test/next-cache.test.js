import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Valkey from 'iovalkey'
import { request } from 'undici'

import { start } from '../index.js'
import { setUpEnvironment, startICC } from './helper.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Matches the host port exposed by docker-compose.yml and the CI service
const valkeyPort = 6390
const appPort = 3043

async function startNextApp (t, fixture, applicationId) {
  const applicationName = 'test-next'
  const applicationPath = join(__dirname, 'fixtures', fixture)

  // The application starts in production mode, so the fixture needs a build;
  // reuse an existing one to keep local reruns fast.
  if (!existsSync(join(applicationPath, 'web', 'next', '.next', 'BUILD_ID'))) {
    execFileSync(join(__dirname, '..', 'node_modules', '.bin', 'platformatic'), ['build', applicationPath], {
      stdio: 'ignore'
    })
  }

  const clientOpts = {
    host: '127.0.0.1',
    port: valkeyPort,
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
    PLT_APP_PORT: appPort,
    PLT_METRICS_PORT: 9092
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  return app
}

// The runtime reports a Next.js application as '@platformatic/next' (older
// runtimes said 'next'). The Next patches, cache adapter included, must be
// applied in both cases.
test('should configure the Next.js cache adapter for @platformatic/next applications', async (t) => {
  const applicationId = randomUUID()
  const app = await startNextApp(t, 'runtime-next', applicationId)

  const runtimeConfig = app.watt.runtime.getRuntimeConfig(true)
  const nextApplication = runtimeConfig.applications.find((application) => application.id === 'next')
  assert.strictEqual(nextApplication.type, '@platformatic/next')

  const nextConfig = await app.watt.runtime.getApplicationConfig('next')
  assert.deepStrictEqual(nextConfig.cache, {
    adapter: 'valkey',
    url: `valkey://cache-user:cache-pass@127.0.0.1:${valkeyPort}`,
    prefix: `${applicationId}:`,
    maxTTL: 604800
  })
})

// The fixture enables the Cache Components in its own cache options, which must
// survive the patch that sets the Valkey connection
test('should keep the cache options of @platformatic/next applications', async (t) => {
  const applicationId = randomUUID()
  const app = await startNextApp(t, 'runtime-next-components', applicationId)

  const nextConfig = await app.watt.runtime.getApplicationConfig('next')
  assert.deepStrictEqual(nextConfig.cache, {
    adapter: 'valkey',
    url: `valkey://cache-user:cache-pass@127.0.0.1:${valkeyPort}`,
    prefix: `${applicationId}:`,
    maxTTL: 604800,
    cacheComponents: true
  })

  const { statusCode, body } = await request(`http://127.0.0.1:${appPort}/`)
  assert.strictEqual(statusCode, 200)
  assert.match(await body.text(), /Hello watt-extra/)

  // The "use cache" entry is stored in Valkey, under the prefix set by watt-extra
  const valkey = new Valkey(`valkey://cache-user:cache-pass@127.0.0.1:${valkeyPort}`)
  t.after(() => valkey.quit())

  let keys = []
  for (const deadline = Date.now() + 5000; !keys.length && Date.now() < deadline;) {
    await sleep(100)
    keys = await valkey.keys(`${applicationId}::cache:next:*:components:values:*`)
  }

  assert.strictEqual(keys.length, 1)
})
