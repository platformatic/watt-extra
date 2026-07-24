import { request } from 'undici'

async function scheduler (app, _opts) {
  // Collects configured and application-level jobs owned by the runtime.
  async function collectSchedulerJobs () {
    const runtime = app.watt.runtime

    if (typeof runtime.getScheduler === 'function') {
      return runtime.getScheduler()
    }

    // Legacy compatibility path: use the original configuration, since the runtime one
    // has been disabled by the config patch (see Watt#configureScheduler)
    const jobs = app.watt.getOriginalSchedulerConfig?.() ?? []
    return jobs
      .filter((job) => job.enabled !== false)
      .map((job) => ({
        name: job.name,
        cron: job.cron,
        callbackUrl: job.callbackUrl,
        method: job.method ?? 'GET',
        headers: job.headers ?? {},
        body: job.body ?? {},
        maxRetries: job.maxRetries ?? 3,
        source: 'config'
      }))
  }

  // Executes a job triggered centrally by ICC (run-scheduled-job command).
  // The job runs in this pod only: ICC dispatches each tick to a single pod.
  async function runScheduledJob (params = {}) {
    const runtime = app.watt.runtime
    if (!runtime) {
      throw new Error('Runtime not started, cannot run scheduled job')
    }

    const { name, callbackUrl, method = 'GET', headers = {}, body, source = 'config' } = params

    app.log.info({ name, source }, 'Executing scheduled job triggered by ICC')

    // Runtime-managed jobs, including application-level tasks, do not need a
    // callback URL. Legacy config jobs fall back to their callback below.
    if (typeof runtime.runSchedulerJob === 'function') {
      return runtime.runSchedulerJob(name)
    }

    if (source === 'application') {
      throw new Error(`Cannot execute application scheduled job "${name}": runtime scheduler controls are unavailable`)
    }

    if (!callbackUrl) {
      throw new Error(`Cannot execute scheduled job "${name}": no callback URL`)
    }

    const url = new URL(callbackUrl)
    const bodyString = body == null || typeof body === 'string' ? body : JSON.stringify(body)

    let statusCode
    if (url.hostname.endsWith('.plt.local')) {
      // Internal mesh URL: route the request through the runtime
      const applicationId = url.hostname.slice(0, -'.plt.local'.length)
      const res = await runtime.inject(applicationId, {
        method,
        url: `${url.pathname}${url.search}`,
        headers,
        body: bodyString ?? undefined
      })
      statusCode = res.statusCode
    } else {
      const res = await request(callbackUrl, { method, headers, body: bodyString ?? undefined })
      await res.body.dump()
      statusCode = res.statusCode
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Scheduled job "${name}" failed with HTTP ${statusCode}`)
    }

    app.log.info({ name, statusCode }, 'Scheduled job executed')
    return { name, statusCode }
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
