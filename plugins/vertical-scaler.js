import os from 'node:os'
import ScalingAlgorithm from '../lib/scaling-algorithm.js'

async function scaler (app, _opts) {
  function setupScaler () {
    const maxWorkers = app.env.PLT_MAX_WORKERS ?? os.cpus().length

    const scalingAlgorithm = new ScalingAlgorithm({ maxWorkers })
    const runtime = app.watt.runtime

    runtime.on('application:worker:health', async (healthInfo) => {
      if (!healthInfo) {
        app.log.error('No health info received')
        return
      }
      scalingAlgorithm.addWorkerHealthInfo(healthInfo)

      if (healthInfo.unhealthy) {
        await checkForScaling()
      }

      async function checkForScaling () {
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
      }
    })

    async function applyRecommendations (recommendations) {
      const resourcesUpdates = []
      for (const recommendation of recommendations) {
        resourcesUpdates.push({
          application: recommendation.applicationId,
          workers: recommendation.workersCount
        })
      }

      await runtime.updateApplicationsResources(resourcesUpdates)
    }
  }
  app.setupScaler = setupScaler
}

export default scaler
