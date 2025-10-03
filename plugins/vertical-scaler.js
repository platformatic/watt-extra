import os from 'node:os'
import ScalingAlgorithm from '../lib/scaling-algorithm.js'

async function scaler (app, _opts) {
  function setupScaler () {
    const maxWorkers = app.env.PLT_MAX_WORKERS ?? os.cpus().length
    const cooldown = app.env.PLT_VERTICAL_SCALER_COOLDOWN_SEC
    const scaleUpELU = app.env.PLT_VERTICAL_SCALER_SCALE_UP_ELU
    const scaleDownELU = app.env.PLT_VERTICAL_SCALER_SCALE_DOWN_ELU
    const timeout = app.env.PLT_VERTICAL_SCALER_TIMEOUT_SEC
    const timeWindowSec = app.env.PLT_VERTICAL_SCALER_METRICS_TIME_WINDOW_SEC

    const scalingAlgorithm = new ScalingAlgorithm({
      maxWorkers,
      scaleUpELU,
      scaleDownELU,
      timeWindowSec
    })

    const runtime = app.watt.runtime

    runtime.on('application:worker:health', async (healthInfo) => {
      if (!healthInfo) {
        app.log.error('No health info received')
        return
      }

      scalingAlgorithm.addWorkerHealthInfo(healthInfo)

      if (healthInfo.currentHealth.elu > scaleUpELU) {
        await checkForScaling()
      }
    })

    // Timeout for the scaling down check
    setTimeout(checkForScaling, timeout * 1000).unref()

    let isScaling = false
    let lastScaling = 0

    async function checkForScaling () {
      const isInCooldown = Date.now() < lastScaling + cooldown * 1000
      if (isScaling || isInCooldown) return
      isScaling = true

      try {
        const workersInfo = await runtime.getWorkers()

        const appsWorkersInfo = {}
        for (const worker of Object.values(workersInfo)) {
          // TODO: check worker status
          const applicationId = worker.application
          appsWorkersInfo[applicationId] ??= 0
          appsWorkersInfo[applicationId]++
        }

        const recommendations = scalingAlgorithm.getRecommendations(appsWorkersInfo)
        if (recommendations.length > 0) {
          await applyRecommendations(recommendations)
        }
      } catch (err) {
        app.log.error({ err }, 'Failed to scale the app')
      } finally {
        isScaling = false
        lastScaling = Date.now()
      }
    }

    async function applyRecommendations (recommendations) {
      const resourcesUpdates = []
      for (const recommendation of recommendations) {
        const { applicationId, workersCount, direction } = recommendation
        app.log.info(`Scaling ${direction} the "${applicationId}" app to ${workersCount} workers`)

        resourcesUpdates.push({
          application: applicationId,
          workers: workersCount
        })
      }
      await runtime.updateApplicationsResources(resourcesUpdates)
    }
  }

  app.setupScaler = setupScaler
}

export default scaler
