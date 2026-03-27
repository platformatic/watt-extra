import buildApp from './app.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createCliLogger, findConfigurationFileRecursive, loadConfigurationFile } from '@platformatic/foundation'

async function createLogger () {
  const root = (process.env.PLT_APP_DIR && resolve(process.env.PLT_APP_DIR)) ||
    process.cwd()
  const configPath = await findConfigurationFileRecursive(root)
  const config = configPath ? await loadConfigurationFile(configPath) : {}

  const loggerConfig = config?.logger ?? {}
  const noPretty = !process.stdout.isTTY

  return createCliLogger(
    process.env.PLT_LOG_LEVEL || 'info',
    noPretty,
    loggerConfig
  )
}

// This starts the app and sends the info to ICC, so it's the main entry point
async function start (logger) {
  if (!logger) {
    logger = await createLogger()
  }

  const app = await buildApp(logger)

  app.log.info('Starting Runtime')
  await app.startRuntime()

  app.log.info('Setup health check')
  await app.setupAlerts()
  await app.setupHealthSignals()
  await app.setupFlamegraphs()

  app.log.info('Sending info to ICC')
  await app.sendToICCWithRetry()
  return app
}

// Check if this file is being run directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
  start().catch(err => {
    console.error(`Failed to start application: ${err.message}`)
    process.exit(1)
  })
}

export {
  start,
  createLogger
}
