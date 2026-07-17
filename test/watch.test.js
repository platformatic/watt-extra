import assert from 'node:assert'
import { test } from 'node:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { randomUUID } from 'node:crypto'
import { setUpEnvironment, startICC, installDeps } from './helper.js'
import { start } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// watt-extra always starts the runtime with isProduction: true, so the runtime
// must resolve watch to false. The runtime defaults watch to !isProduction, and
// reads isProduction from the options passed to its transform, so a transform
// that does not forward them silently enables file watching in production.
// This needs a @platformatic/runtime app: a single-application config instead
// goes through wrapInRuntimeConfig, which never calls the custom transform.
test('should disable file watching in production', async (t) => {
  const appName = 'test-app'
  const applicationId = randomUUID()
  const applicationPath = join(__dirname, 'fixtures', 'runtime-service')

  await installDeps(t, applicationPath)

  const icc = await startICC(t, {
    applicationId,
    port: 3011
  })

  setUpEnvironment({
    PLT_APP_NAME: appName,
    PLT_APP_DIR: applicationPath,
    PLT_ICC_URL: icc.iccUrl,
    PLT_CONTROL_PLANE_URL: 'http://127.0.0.1:3012',
    PLT_APP_PORT: 3053,
    PLT_METRICS_PORT: 9102
  })

  const app = await start()

  t.after(async () => {
    await app.close()
    await icc.close()
  })

  const mainConfig = app.watt.runtime.getRuntimeConfig(true)

  assert.strictEqual(mainConfig.watch, false)

  for (const application of mainConfig.applications ?? []) {
    assert.strictEqual(application.watch, false, `application ${application.id} must not watch files`)
  }
})
