async function scheduler (app, _opts) {
  // Collects configured and application-level jobs owned by the runtime.
  async function collectSchedulerJobs () {
    return app.watt.runtime.getSchedulerJobs()
  }

  // Executes a job triggered centrally by ICC (run-scheduled-job command).
  // The job runs in this pod only: ICC dispatches each tick to a single pod.
  async function runScheduledJob (params = {}) {
    const runtime = app.watt.runtime
    if (!runtime) {
      throw new Error('Runtime not started, cannot run scheduled job')
    }

    const { name, source = 'config' } = params

    app.log.info({ name, source }, 'Executing scheduled job triggered by ICC')

    return runtime.runSchedulerJob(name)
  }

  async function sendSchedulerInfo () {
    // Skip scheduler configuration if ICC is not configured
    if (!app.env.PLT_ICC_URL) {
      app.log.info('PLT_ICC_URL not set, skipping scheduler configuration')
      return
    }

    // Legacy ICC integration path: the current API exposes one PUT endpoint
    // per job. Newer ICC versions register application jobs from state.
    try {
      const applicationId = app.instanceConfig?.applicationId
      const { default: build, setDefaultHeaders } = await import('../clients/cron/cron.mjs')

      const cronUrl = app.instanceConfig?.iccServices?.cron?.url
      if (!cronUrl) {
        app.log.warn('No cron URL found in ICC services')
        return
      }
      const cronClient = build(cronUrl)
      setDefaultHeaders(await app.getAuthorizationHeaders())

      const jobs = await collectSchedulerJobs()
      const configJobs = jobs.filter((job) => job.source === 'config')
      const applicationJobs = jobs.filter((job) => job.source === 'application')

      async function saveJob (job) {
        const iccJob = {
          name: job.name,
          schedule: job.cron,
          method: job.method,
          maxRetries: job.maxRetries,
          applicationId
        }

        if (job.source === 'application') {
          iccJob.source = job.source
          iccJob.scheduleId = job.scheduleId
          iccJob.tasks = job.tasks
        } else {
          iccJob.callbackUrl = job.callbackUrl
          if (job.headers && Object.keys(job.headers).length > 0) {
            iccJob.headers = job.headers
          }
          if (job.body && (typeof job.body === 'string' ? job.body.length > 0 : Object.keys(job.body).length > 0)) {
            iccJob.body = job.body
          }
        }

        const result = await cronClient.putWattJobs(iccJob)
        if (result.statusCode >= 400) {
          const error = new Error(`ICC returned HTTP ${result.statusCode} while saving job "${job.name}"`)
          error.statusCode = result.statusCode
          throw error
        }
      }

      for (const job of configJobs) {
        await saveJob(job)
      }

      for (const [index, job] of applicationJobs.entries()) {
        try {
          await saveJob(job)
        } catch (error) {
          if (index === 0 && error.statusCode === 400) {
            app.log.warn('ICC does not support application scheduler jobs, skipping application registrations')
            break
          }
          throw error
        }
      }

      app.log.info('Scheduler configured')
    } catch (error) {
      app.log.error(error, 'Failed in configuring watt jobs in ICC')
      throw error
    }
  }

  app.sendSchedulerInfo = sendSchedulerInfo
  app.collectSchedulerJobs = collectSchedulerJobs
  app.runScheduledJob = runScheduledJob
}

export default scheduler
