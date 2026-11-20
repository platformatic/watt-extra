import { aggregateDrain, aggregateObjects, aggregatePromotion, aggregateResume, COMMANDS, isLavoratoreApplication } from '../lib/durable-objects.js'

// Forwards the Durable Objects commands of ICC to the Lavoratore applications of the runtime, see lib/durable-objects.js
async function durableObjects (app, _opts) {
  // The Lavoratore applications of the runtime: the configuration does not change while it runs
  let applications

  async function lavoratoreApplications () {
    const runtime = app.watt?.runtime

    if (!runtime) {
      throw new Error('Runtime not started, cannot reach the Durable Objects applications')
    }

    if (!applications) {
      const found = []

      for (const application of runtime.getRuntimeConfig(true).applications ?? []) {
        if (await isLavoratoreApplication(application)) {
          found.push(application.id)
        }
      }

      applications = found
    }

    // ICC sends these commands only to the pods it knows to run Lavoratore: finding none is a failure to recognize the
    // applications, not a pod with nothing to promote or drain, and ICC must not take it for done
    if (applications.length === 0) {
      throw new Error('No Lavoratore application found in the runtime')
    }

    return applications
  }

  // The commands which change whether the pod drains
  const ORDERED = new Set(['durable-objects-drain', 'durable-objects-resume'])

  // The commands in flight, by command and parameters: ICC repeats a command which did not answer in time, and the
  // repetition joins the one still running instead of starting another
  const inflight = new Map()

  // Runs a command on every Lavoratore application: a promotion with { generation }, a drain, the resume of a drained
  // pod, or the list of the objects the pod holds. Returns the aggregate
  // of their answers, see lib/durable-objects.js. An application which has no handler for the command, i.e. without
  // Durable Objects placed across pods, or with a version of Lavoratore which predates the commands, is skipped: it has
  // nothing to promote or drain, and ICC must not wait for it. The applications are all asked even when one fails, and
  // the failure is reported with what the others answered.
  function sendDurableObjectsCommand (command, params = {}) {
    const name = COMMANDS[command]

    if (!name) {
      return Promise.reject(new Error(`Unknown Durable Objects command "${command}"`))
    }

    const key = `${command}:${JSON.stringify(params)}`

    if (ORDERED.has(command)) {
      return sendInOrder(command, name, params, key)
    }

    let running = inflight.get(key)

    if (!running) {
      running = runCommand(command, name, params).finally(() => inflight.delete(key))
      inflight.set(key, running)
    }

    return running
  }

  // A drain and a resume undo each other, and each one asks the applications one after the other: run at once, a
  // resume could reach every application while an earlier drain waits for the first one, and that drain would then
  // leave the others draining behind a pod reported as resumed. So they run one at a time, in the order they arrived,
  // and the state of the pod is the one of the last command. A repetition joins the command it repeats only while
  // that one is the last which arrived: after an opposing command it is a new request, and runs after it.
  let tail = Promise.resolve()
  let last = null

  function sendInOrder (command, name, params, key) {
    if (last?.key === key && !last.settled) {
      return last.running
    }

    const entry = { key, settled: false, running: null }
    const settle = () => { entry.settled = true }

    entry.running = tail.then(() => runCommand(command, name, params))
    entry.running.then(settle, settle)
    tail = entry.running.catch(() => {})
    last = entry

    return entry.running
  }

  async function runCommand (command, name, params) {
    const results = {}
    const skipped = []
    const errors = []

    for (const id of await lavoratoreApplications()) {
      try {
        const result = await app.watt.runtime.sendCommandToApplication(id, name, params)

        // The runtime answers {} when the application has no handler for the command
        if (!result || typeof result !== 'object' || Object.keys(result).length === 0) {
          skipped.push(id)
        } else {
          results[id] = result
        }
      } catch (err) {
        errors.push(`${id}: ${err.message}`)
      }
    }

    if (errors.length > 0) {
      const error = new Error(`The ${command} command failed in the applications ${errors.join('; ')}`)
      error.results = results
      throw error
    }

    let aggregate

    if (command === 'durable-objects-promote') {
      aggregate = aggregatePromotion(results)
    } else if (command === 'durable-objects-list') {
      aggregate = aggregateObjects(results)
    } else if (command === 'durable-objects-resume') {
      aggregate = aggregateResume(results, skipped)
    } else {
      aggregate = aggregateDrain(results)
    }

    return skipped.length > 0 ? { ...aggregate, skipped } : aggregate
  }

  app.sendDurableObjectsCommand = sendDurableObjectsCommand
}

export default durableObjects
