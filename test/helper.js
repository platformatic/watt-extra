import { Agent, setGlobalDispatcher } from 'undici'
import fastify from 'fastify'
import fp from 'fastify-plugin'
import why from 'why-is-node-running'
import fastifyWebsocket from '@fastify/websocket'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

setInterval(why, 120000).unref()

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10,
  keepAliveMaxTimeout: 10
}))

const originalEnvironment = { ...process.env }

function setUpEnvironment (env = {}) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLT_') && !(key in originalEnvironment)) delete process.env[key]
  }
  const defaultEnv = {
    PLT_APP_HOSTNAME: '127.0.0.1',
    PLT_APP_PORT: 3042,
    PLT_METRICS_PORT: 9090,
    PLT_DISABLE_COMPLIANCE_CHECK: 'true',
    PLT_DISABLE_FLAMEGRAPHS: 'true',
    PLT_THROW_ON_COMPLIANCE_FAILURE: 'false',
    PLT_ALERTS_GRACE_PERIOD_SEC: '0', // Disable grace period for tests
    PLT_TEST_TOKEN: createJwtToken(3600)
  }
  Object.assign(process.env, defaultEnv, env)
}

// Only compliance fixtures need synthetic dependencies. Watt packages resolve
// from this repository's node_modules, at the same version as the host runtime.
export async function installDeps (t, appDir, _packageNames, dependencies = []) {
  for (const { name, version } of dependencies) {
    const directory = join(appDir, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version }))
    t.after(() => rm(directory, { recursive: true, force: true }))
  }
}

async function startICC (t, opts = {}) {
  const {
    applicationId,
    applicationName,
    applicationMetricsLabel,
    scaler,
    iccServices: customIccServices,
    iccConfig = {},
    enableOpenTelemetry = false,
    enableSlicerInterceptor = false,
    enableTrafficInterceptor = false,
    controlPlaneResponse,
    port = 3000
  } = opts

  let iccServices = customIccServices

  const icc = fastify({
    keepAliveTimeout: 1,
    forceCloseConnections: true
  })
  t.after(() => icc.close())

  await icc.register(fastifyWebsocket)

  // Main
  await icc.register(fp(async (icc) => {
    const connections = new Map()

    icc.decorate('emitApplicationUpdate', (applicationId, config) => {
      const appConnections = connections.get(applicationId)
      if (appConnections) {
        for (const connection of appConnections) {
          connection.send(JSON.stringify(config))
        }
      }
    })

    icc.get('/api/updates/applications/:id', { websocket: true }, async (connection, req) => {
      connection.on('message', (message) => {
        const applicationId = req.params.id
        const { command, topic } = JSON.parse(message.toString())

        if (command === 'subscribe' && topic === '/config') {
          connection.send(JSON.stringify({ command: 'ack' }))
        }

        let appConnections = connections.get(applicationId)
        if (!appConnections) {
          appConnections = []
          connections.set(applicationId, appConnections)
        }
        appConnections.push(connection)
      })
    })
  }))

  // Control Plane
  await icc.register(async (icc) => {
    icc.post('/pods/:podId/instance', async (req) => {
      if (typeof controlPlaneResponse === 'function') {
        return controlPlaneResponse(req)
      }
      return controlPlaneResponse || {
        applicationId,
        applicationName,
        applicationMetricsLabel,
        iccServices,
        scaler,
        config: iccConfig,
        enableOpenTelemetry,
        enableSlicerInterceptor,
        enableTrafficInterceptor
      }
    })

    icc.post('/applications/:id/metadata', async (req) => {
      const { applicationId, data } = req.body
      return opts.saveComplianceMetadata?.(applicationId, data)
    })

    icc.post('/pods/:id/instance/state', async (req) => {
      const instanceId = req.params.id
      const state = req.body

      await opts.saveApplicationInstanceState?.({ instanceId, state })
      return {}
    })
  }, { prefix: '/control-plane' })

  // Compliance
  await icc.register(async (icc) => {
    icc.post('/metadata', async (req) => {
      const { applicationId, data } = req.body
      return opts.saveComplianceMetadata?.(applicationId, data)
    })

    icc.post('/compliance', async (req) => {
      const { applicationId } = req.body
      return opts.getComplianceReport?.(applicationId)
    })
  }, { prefix: '/compliance' })

  // Traffic Inspector
  await icc.register(async (icc) => {
    icc.post('/requests/hash', async (req) => {
      const { taxonomyId, applicationId } = JSON.parse(req.headers['x-labels'])
      const { timestamp, request, response } = req.body
      opts.saveRequestHash?.({ taxonomyId, applicationId, timestamp, request, response })
    })

    icc.post('/requests', async (req) => {
      const { taxonomyId, applicationId } = JSON.parse(req.headers['x-labels'])
      const request = JSON.parse(req.headers['x-request-data'])
      const response = JSON.parse(req.headers['x-response-data'])
      response.body = req.body

      opts.saveRequest?.({ taxonomyId, applicationId, request, response })
    })
  }, { prefix: '/traffic-inspector' })

  // Risk Service
  await icc.register(async (icc) => {
    icc.addContentTypeParser(
      'application/x-protobuf',
      (req, payload, done) => {
        payload.resume()
        payload.on('end', done)
      }
    )
    icc.post('/v1/traces', async () => {})
  }, { prefix: '/risk-service' })

  // Scaler
  await icc.register(async (icc) => {
    icc.addContentTypeParser(
      'application/octet-stream',
      function (request, payload, done) {
        const chunks = []
        payload.on('data', chunk => chunks.push(chunk))
        payload.on('end', () => {
          done(null, Buffer.concat(chunks))
        })
        payload.on('error', done)
      }
    )
    icc.post('/alerts', async (req) => {
      return opts.processAlerts?.(req)
    })
    icc.post('/signals', async (req) => {
      return opts.processSignals?.(req)
    })
    icc.post('/ready', async (req) => {
      return opts.processReady?.(req) ?? { success: true }
    })
    icc.post('/pods/:podId/services/:serviceId/flamegraph', async (req) => {
      return opts.processFlamegraphs?.(req)
    })
    icc.post('/flamegraphs/:flamegraphId/alerts', async (req) => {
      return opts.attachFlamegraphToAlerts?.(req)
    })
  }, { prefix: '/scaler' })

  // Cron
  await icc.register(async (icc) => {
    icc.put('/watt-jobs', async (req) => {
      const body = req.body
      opts.saveWattJob?.(body)
    })
  }, { prefix: '/cron' })

  await icc.listen({ port })

  // Set default iccServices if not provided
  if (!iccServices) {
    iccServices = {
      riskEngine: {
        url: `http://127.0.0.1:${port}/risk-service`
      },
      trafficInspector: {
        url: `http://127.0.0.1:${port}/traffic-inspector`
      },
      compliance: {
        url: `http://127.0.0.1:${port}/compliance`
      },
      cron: {
        url: `http://127.0.0.1:${port}/cron`
      },
      scaler: {
        url: `http://127.0.0.1:${port}/scaler`
      }
    }
  }

  // Attach iccServices and baseUrl to the icc instance for tests to access
  icc.iccServices = iccServices
  icc.iccUrl = `http://127.0.0.1:${port}`

  return icc
}

function createJwtToken (expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const currentTime = Math.floor(Date.now() / 1000)
  const payload = {
    sub: '1234567890',
    iat: currentTime,
    exp: currentTime + (expiresInSeconds || 3600) // Default 1 hour expiration
  }
  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=/g, '')
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=/g, '')
  const signature = 'test_signature'
  return `${base64Header}.${base64Payload}.${signature}`
}

export {
  setUpEnvironment,
  startICC,
  createJwtToken
}
