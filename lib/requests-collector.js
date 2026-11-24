const REQUESTS_METRIC = 'http_request_all_duration_seconds'

// Collects the requests each service received since the previous read of the metrics
class RequestsCollector {
  #isHttpMetricsReset
  #workerStates = new Map()

  constructor (isHttpMetricsReset) {
    this.#isHttpMetricsReset = isHttpMetricsReset
  }

  collect (metrics, workers, serviceLabel) {
    this.#updateWorkerStates(workers)

    const requestCounts = {}
    for (const { name, values } of metrics) {
      if (name !== REQUESTS_METRIC || values.length === 0) continue

      // The runtime adds one entry per worker: all its values have the same service and worker
      const { [serviceLabel]: serviceId, workerId } = values[0].labels
      if (serviceId === undefined || workerId === undefined) continue

      const workerRequests = this.#getNewWorkerRequests(values, `${serviceId}:${workerId}`)
      const serviceRequests = requestCounts[serviceId] ?? 0
      requestCounts[serviceId] = serviceRequests + workerRequests
    }
    return requestCounts
  }

  #getNewWorkerRequests (values, workerKey) {
    let requestCount = 0
    for (const { metricName, value } of values) {
      if (metricName === `${REQUESTS_METRIC}_count`) {
        requestCount += value
      }
    }
    if (this.#isHttpMetricsReset) return requestCount

    let workerState = this.#workerStates.get(workerKey)
    if (!workerState) {
      workerState = { thread: null, requestCount: 0 }
      this.#workerStates.set(workerKey, workerState)
    }

    const previousRequestCount = workerState.requestCount
    workerState.requestCount = requestCount

    if (requestCount < previousRequestCount) {
      return requestCount
    }
    return requestCount - previousRequestCount
  }

  #updateWorkerStates (workers) {
    for (const [workerKey, workerState] of this.#workerStates) {
      const worker = workers[workerKey]
      if (!worker) {
        this.#workerStates.delete(workerKey)
        continue
      }

      workerState.thread ??= worker.thread
      if (workerState.thread !== worker.thread) {
        this.#workerStates.delete(workerKey)
      }
    }

    for (const [workerKey, { thread }] of Object.entries(workers)) {
      if (!this.#workerStates.has(workerKey)) {
        this.#workerStates.set(workerKey, { thread, requestCount: 0 })
      }
    }
  }
}

export { RequestsCollector }
