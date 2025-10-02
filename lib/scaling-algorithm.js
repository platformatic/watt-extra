class ScalingAlgorithm {
  #scaleUpELU
  #scaleDownELU
  #maxWorkers
  #timeWindowSec
  #appsELUs
  #minELUDiff

  constructor (options = {}) {
    this.#scaleUpELU = options.scaleUpELU ?? 0.8
    this.#scaleDownELU = options.scaleDownELU ?? 0.2
    this.#maxWorkers = options.maxWorkers ?? 10
    this.#minELUDiff = options.minELUDiff ?? 0.2
    this.#timeWindowSec = options.timeWindowSec ?? 60

    this.#appsELUs = {}
  }

  processWorkerHealthInfo (healthInfo) {
    const workerId = healthInfo.id
    const applicationId = healthInfo.applicationId
    const elu = healthInfo.currentHealth.elu
    const timestamp = Date.now()

    if (!this.#appsELUs[applicationId]) {
      this.#appsELUs[applicationId] = {}
    }
    if (!this.#appsELUs[applicationId][workerId]) {
      this.#appsELUs[applicationId][workerId] = []
    }
    this.#appsELUs[applicationId][workerId].push({ elu, timestamp })
    this.#removeOutdatedAppELUs(applicationId)
  }

  getRecommendations (workersInfo) {
    let totalWorkersCount = workersInfo.length
    let appsInfo = []

    for (const worker of workersInfo) {
      const applicationId = worker.application

      let appInfo = appsInfo.find((app) => app.applicationId === applicationId)
      if (!appInfo) {
        const elu = this.#calculateAppELU(applicationId)
        appInfo = { applicationId, elu, workersCount: 0 }
        appsInfo.push(appInfo)
      }

      appInfo.workersCount++
    }

    appsInfo = appsInfo.sort(
      (app1, app2) => {
        if (app1.elu > app2.elu) return 1
        if (app1.elu < app2.elu) return -1
        if (app1.workersCount < app2.workersCount) return 1
        if (app1.workersCount > app2.workersCount) return -1
        return 0
      }
    )

    const recommendations = []
    for (let i = 0; i < appsInfo.length; i++) {
      const { applicationId, elu, workersCount } = appsInfo[i]

      if (elu < this.#scaleDownELU && workersCount > 1) {
        recommendations.push({
          applicationId,
          workersCount: workersCount - 1,
          direction: 'down'
        })
        totalWorkersCount--
      }
    }

    const scaleUpCandidate = appsInfo.at(-1)
    if (scaleUpCandidate.elu > this.#scaleUpELU) {
      const { applicationId, workersCount } = scaleUpCandidate

      if (totalWorkersCount >= this.#maxWorkers) {
        const scaleDownCandidate = appsInfo.at(0)
        const eluDiff = scaleUpCandidate.elu - scaleDownCandidate.elu
        const workersDiff = scaleDownCandidate.workersCount - scaleUpCandidate.workersCount

        if (eluDiff >= this.#minELUDiff || workersDiff >= 2) {
          recommendations.push({
            applicationId: scaleDownCandidate.applicationId,
            workersCount: scaleDownCandidate.workersCount - 1,
            direction: 'down'
          })
          recommendations.push({
            applicationId,
            workersCount: workersCount + 1,
            direction: 'up'
          })
        }
      } else {
        recommendations.push({
          applicationId,
          workersCount: workersCount + 1,
          direction: 'up'
        })
        totalWorkersCount++
      }
    }

    return recommendations
  }

  #calculateAppELU (applicationId) {
    this.#removeOutdatedAppELUs(applicationId)

    const appELUs = this.#appsELUs[applicationId]
    if (!appELUs) return

    let eluSum = 0
    let eluCount = 0

    for (const workerId in appELUs) {
      const workerELUs = appELUs[workerId]
      const workerELUSum = workerELUs.reduce(
        (sum, workerELU) => sum + workerELU.elu, 0
      )
      eluSum += workerELUSum / workerELUs.length
      eluCount++
    }

    return Math.round(eluSum / eluCount * 100) / 100
  }

  #removeOutdatedAppELUs (applicationId) {
    const appELUs = this.#appsELUs[applicationId]
    if (!appELUs) return

    const now = Date.now()

    for (const workerId in appELUs) {
      const workerELUs = appELUs[workerId]

      for (let i = 0; i < workerELUs.length; i++) {
        const timestamp = workerELUs[i].timestamp
        if (timestamp < now - this.#timeWindowSec * 1000) {
          workerELUs.splice(0, i)
          break
        }
      }

      // If there are no more workerELUs, remove the workerId
      if (workerELUs.length === 0) {
        delete appELUs[workerId]
      }
    }
  }
}

export default ScalingAlgorithm

