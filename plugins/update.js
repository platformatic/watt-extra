import WebSocket from 'ws'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

function createWebSocketUrl (httpUrl, path, queryParams = {}) {
  const url = new URL(httpUrl)
  url.protocol = url.protocol.replace('http', 'ws')
  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  url.pathname = `${basePath}${path}`
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

async function updatePlugin (app) {
  const reconnectInterval = app.env.PLT_UPDATES_RECONNECT_INTERVAL_SEC * 1000
  const heartbeatInterval = (app.env.PLT_UPDATES_HEARTBEAT_INTERVAL_SEC ?? 30) * 1000
  const ackTimeout = (app.env.PLT_UPDATES_ACK_TIMEOUT_SEC ?? 10) * 1000
  const kAckTimeout = Symbol('kAckTimeout')

  let socket = null

  // A half-open connection (e.g. the ICC endpoint died without a TCP reset
  // reaching the pod) fires no 'close' event: without a heartbeat the pod
  // believes it is connected forever and becomes unreachable for ICC
  // commands, while its outgoing HTTP calls keep working. Ping the server
  // and terminate the socket when the pong does not come back, so the close
  // handler runs and the reconnect loop takes over. The server side of ws
  // answers pings automatically, so this works against any ICC version.
  function startHeartbeat (ws) {
    let alive = true
    ws.on('pong', () => {
      alive = true
    })

    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }
      if (!alive) {
        app.log.warn('Updates websocket heartbeat timed out, terminating the connection')
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, heartbeatInterval)
    timer.unref()

    ws.on('close', () => {
      clearInterval(timer)
    })
  }

  async function processMessage (data) {
    try {
      const message = JSON.parse(data)
      const { topic, type, command } = message

      // Handle trigger-flamegraph command from ICC
      if (command === 'trigger-flamegraph') {
        app.log.info({ command }, 'Received trigger-flamegraph command from ICC')
        app.sendFlamegraphs({ profileType: 'cpu' })
        return
      }

      // Handle trigger-heapprofile command from ICC
      if (command === 'trigger-heapprofile') {
        app.log.info({ command }, 'Received trigger-heapprofile command from ICC')
        app.sendFlamegraphs({ profileType: 'heap' })
        return
      }

      // Handle profiling activation/deactivation commands from ICC.
      // Fire and forget: the outcome is reported through the profiling
      // states channel, not through a command reply.
      if (command === 'start-profiling' || command === 'stop-profiling') {
        const enabled = command === 'start-profiling'
        const types = message.params?.types
        app.log.info({ command, types }, 'Received profiling toggle command from ICC')
        try {
          await app.setProfilingEnabled(enabled, types ?? undefined)
        } catch (err) {
          app.log.error({ err, command }, 'Failed to toggle profiling')
        }
        return
      }

      // Handle a centrally coordinated cron job execution: ICC dispatches
      // each tick to exactly one pod of the application, this one.
      if (command === 'run-scheduled-job') {
        app.log.info({ command, job: message.params?.name }, 'Received run-scheduled-job command from ICC')
        try {
          const result = await app.runScheduledJob(message.params ?? {})
          if (message.requestId) {
            socket.send(JSON.stringify({
              requestId: message.requestId,
              success: result?.success !== false,
              result
            }))
          }
        } catch (error) {
          if (message.requestId) {
            socket.send(JSON.stringify({
              requestId: message.requestId,
              success: false,
              error: { message: error.message, name: error.name }
            }))
          }
          throw error
        }
        return
      }

      // Handle updates websocket format: { type: '...', topic: '...', data: {...} }
      if (!topic || !type) {
        app.log.warn({ message }, 'Received invalid message from updates websocket')
        return
      }

      if (type === 'config-updated') {
        app.log.info({ topic, type }, 'Received config update from updates websocket')
        await app.updateConfig(message)
      } else {
        app.log.info({ topic, type }, 'Received message, not handled type')
      }
    } catch (err) {
      app.log.error(err, 'Error processing message from updates websocket')
    }
  }

  async function connectToUpdates () {
    const applicationId = app.instanceConfig?.applicationId
    if (!applicationId) {
      app.log.warn('No application ID found, cannot connect to updates websocket')
      return null
    }

    const iccUrl = app.env.PLT_ICC_URL
    if (!iccUrl) {
      app.log.warn('No PLT_ICC_URL found in environment, cannot connect to updates websocket')
      return null
    }

    const runtimeId = app.getRuntimeId()
    const wsUrl = createWebSocketUrl(iccUrl, `api/updates/applications/${applicationId}`, { runtimeId })
    app.log.info({ runtimeId }, `Connecting to updates websocket at ${wsUrl}`)

    try {
      const headers = await app.getAuthorizationHeaders()

      // handshakeTimeout turns a hung upgrade into an 'error', so the retry
      // loop is never stuck waiting for an 'open' that cannot arrive
      socket = new WebSocket(wsUrl, { headers, handshakeTimeout: ackTimeout })
      await once(socket, 'open')

      app.log.info('Connected to updates websocket')
      // Subscribing, if subscription fails we throw, so the caller can retry
      const subscribeMsg = JSON.stringify({ command: 'subscribe', topic: '/config' })
      socket.send(subscribeMsg)

      // A connection which closes cleanly between the subscribe and the ack
      // emits no 'error', so an unbounded wait here would hang this loop
      // forever: bound it and retry
      const ackPromise = once(socket, 'message')
      ackPromise.catch(() => {})
      const command = await Promise.race([
        ackPromise,
        sleep(ackTimeout, kAckTimeout, { ref: false })
      ])
      if (command === kAckTimeout) {
        socket.terminate()
        throw new Error('Timed out waiting for the updates subscription acknowledgment')
      }

      const message = JSON.parse(command[0])
      if (message?.command !== 'ack') {
        app.log.error({ message }, 'Subscription updates failed')
        throw new Error('Subscription updates failed')
      }
      app.log.info('Received subscription acknowledgment from updates websocket')

      startHeartbeat(socket)

      // listen for subsequent messages
      socket.on('message', processMessage)

      socket.on('error', (err) => {
        app.log.error(err, 'Error in updates websocket connection')
        reconnectToUpdates()
      })

      socket.on('close', (code, reason) => {
        app.log.info({ code, reason: reason.toString() }, 'Updates websocket connection closed')
        reconnectToUpdates()
      })
    } catch (err) {
      app.log.error(err, 'Failed to connect and subscribe to updates websocket')
      reconnectToUpdates()
    }
  }

  let isReconnecting = false
  let isClosing = false

  async function reconnectToUpdates () {
    if (isReconnecting || isClosing) return
    isReconnecting = true

    await sleep(reconnectInterval)

    isReconnecting = false
    app.log.info('Reconnecting to updates websocket')
    await connectToUpdates()
  }

  app.updateConfig = async (message) => {
    await app.watt.applyIccConfigUpdates(message.data)
  }

  app.connectToUpdates = connectToUpdates
  app.closeUpdates = async () => {
    isClosing = true
    if (socket) {
      socket.close()
      socket = null
    }
  }
}

export default updatePlugin
