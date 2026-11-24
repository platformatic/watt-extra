import { EventEmitter } from 'node:events'

// Reads the runtime metrics once per interval for all the listeners:
// app.metrics 'metrics' ({ metrics, workers, timestamp }).
// They are shared by all the listeners: do not modify them.
async function metrics (app, _opts) {
  const emitter = new EventEmitter({ captureRejections: true })
  emitter.on('error', (err) => {
    app.log.error({ err }, 'A metrics listener failed')
  })
  app.metrics = emitter

  let timer = null
  let collecting = false

  async function collectMetrics () {
    const runtime = app.watt?.runtime
    if (!runtime || emitter.listenerCount('metrics') === 0 || collecting) return

    collecting = true
    try {
      // Before the read, so that a worker stopping during it is listed
      const workers = await runtime.getWorkers()
      const { metrics } = await runtime.getMetrics('json')
      if (metrics === null) return

      const timestamp = Date.now()
      emitter.emit('metrics', { metrics, workers, timestamp })
    } catch (err) {
      app.log.error({ err }, 'Failed to collect the runtime metrics')
    } finally {
      collecting = false
    }
  }

  app.setupMetrics = async () => {
    if (timer !== null) return

    const interval = app.env.PLT_METRICS_COLLECTION_INTERVAL
    timer = setInterval(collectMetrics, interval).unref()
    app.log.info({ interval }, 'Collecting the runtime metrics')
  }

  app.cleanupMetrics = async () => {
    clearInterval(timer)
    timer = null
    emitter.removeAllListeners('metrics')
  }
}

export default metrics
