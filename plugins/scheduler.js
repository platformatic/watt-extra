import { request } from 'undici'

async function scheduler (app, _opts) {
  // Collects the cron jobs defined in the watt runtime: the `scheduler`
  // configuration plus the application-level scheduled tasks (e.g. Nitro
  // scheduled tasks) when the runtime is able to detect them.
  async function collectSchedulerJobs () {
    const runtime = app.watt.runtime

    // Newer runtimes expose the full scheduler status, including scheduled
    // tasks detected inside the applications (source: 'nitro', ...)
    if (typeof runtime.getScheduler === 'function') {
      const jobs = await runtime.getScheduler()
      return jobs.map((job) => ({
        name: job.name,
        cron: job.cron,
        callbackUrl: job.callbackUrl ?? null,
        method: job.method ?? 'GET',
        headers: job.headers ?? {},
        body: job.body ?? {},
        maxRetries: job.maxRetries ?? 3,
        source: job.source ?? 'config',
        applicationId: job.applicationId ?? null,
        taskName: job.taskName ?? null
      }))
    }

    // Older runtimes: use the original configuration, since the runtime one
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

  // Switches the scheduler of the applications defining their own scheduled
  // tasks (e.g. Nitro) between local execution and external coordination.
  // Only supported by newer runtimes.
  async function configureApplicationSchedulers (mode) {
    const runtime = app.watt.runtime
    if (typeof runtime.setApplicationSchedulerMode !== 'function') {
      return
    }

    const jobs = await collectSchedulerJobs()
    const applicationIds = [...new Set(
      jobs
        .filter((job) => job.source !== 'config' && job.applicationId)
        .map((job) => job.applicationId)
    )]

    for (const applicationId of applicationIds) {
      try {
        await runtime.setApplicationSchedulerMode(applicationId, mode)
        app.log.info({ applicationId, mode }, 'Application scheduler mode updated')
      } catch (error) {
        app.log.warn(
          { err: error, applicationId },
          'Cannot switch the application scheduler mode. If this is a Nuxt application, make sure it uses the @platformatic/nuxt/scheduler module.'
        )
      }
    }
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

    // Newer runtimes execute configured jobs natively (including retries)
    if (source === 'config' && typeof runtime.runSchedulerJob === 'function') {
      return runtime.runSchedulerJob(name)
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

    const mode = app.instanceConfig?.scheduler?.mode

    if (mode === 'local') {
      // ICC cron coordination is disabled: the jobs run locally in each pod
      app.log.info('ICC scheduler coordination is disabled, jobs will run locally')
      return
    }

    if (mode === 'external') {
      // The control-plane registers the jobs centrally from the state report
      // (see sendMetadata). The runtime config jobs are already disabled at
      // startup, here we silence the application-level schedulers too.
      await configureApplicationSchedulers('external')
      app.log.info('Scheduler coordination delegated to ICC')
      return
    }

    // Older ICC versions: register each job directly on the cron service
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

      const jobs = (await collectSchedulerJobs()).filter((job) => job.source === 'config')

      const saveJobs = []
      for (const job of jobs) {
        const iccJob = {
          name: job.name,
          callbackUrl: job.callbackUrl,
          schedule: job.cron, // unfortunately, the ICC API uses `schedule` instead of `cron`
          method: job.method,
          maxRetries: job.maxRetries,
          applicationId
        }
        if (job.headers && Object.keys(job.headers).length > 0) {
          iccJob.headers = job.headers
        }
        if (job.body && (typeof job.body === 'string' ? job.body.length > 0 : Object.keys(job.body).length > 0)) {
          iccJob.body = job.body
        }
        saveJobs.push(cronClient.putWattJobs(iccJob))
      }
      const result = await Promise.allSettled(saveJobs)
      const errors = result.filter((job) => job.status === 'rejected')
      if (errors.length > 0) {
        app.log.error(errors, 'Failed to save jobs in ICC')
        throw new AggregateError('Failed to save jobs in ICC', { cause: errors.map(job => job.reason) })
      }

      app.log.info('Scheduler configured')
    } catch (error) {
      app.log.error(error, 'Failed in configuring watt jobs in ICC')
    }
  }

  app.sendSchedulerInfo = sendSchedulerInfo
  app.collectSchedulerJobs = collectSchedulerJobs
  app.runScheduledJob = runScheduledJob
}

export default scheduler
