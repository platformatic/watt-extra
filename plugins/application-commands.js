import { COMMAND_PREFIX } from '../lib/application-commands.js'

// The runtime answers {} for an application which has no handler for a message: that, and nothing else, is an
// application which did not answer. Whatever a handler returns is an answer, false, 0, a string or an array too. A
// handler which returns {} itself cannot be told from a missing one.
function isUnhandled (result) {
  return result !== null && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0
}

// Forwards the commands of ICC to the applications of the runtime, see lib/application-commands.js
async function applicationCommands (app, _opts) {
  // The commands of each queue, see sendApplicationCommand(): where the queue ends, and its last command
  const queues = new Map()
  // The type of each application, as its capability tells it: it does not change while the application runs
  const types = new Map()

  function runtime () {
    if (!app.watt?.runtime) {
      throw new Error('Runtime not started, cannot reach the applications')
    }

    return app.watt.runtime
  }

  function applicationIds () {
    return (runtime().getRuntimeConfig(true).applications ?? []).map(application => application.id)
  }

  // The type of an application, or null when it cannot be told now: it is asked again by the next command
  async function typeOf (id) {
    if (types.has(id)) {
      return types.get(id)
    }

    try {
      const { type = null } = await runtime().getApplicationDetails(id)

      if (type !== null) {
        types.set(id, type)
      }

      return type
    } catch (err) {
      app.log.debug({ err, application: id }, 'Cannot tell the type of an application')
      return null
    }
  }

  // Sends a message to an application of the runtime, or to all of them when none is given, through the ITC of the
  // runtime, and returns what each answered: { applications, skipped, errors, types }. applications has the answers,
  // by application, as they were given. An application which has no handler for the message is skipped. One which
  // fails is in errors, with the message of its error, next to what the others answered. types has the type of each
  // application which was asked, as its capability tells it: ICC tells from it an application which was meant to
  // answer from one which could not. The applications are asked at the same time: none waits for another.
  //
  // Commands which undo each other, as a drain and a resume, must reach the applications in the order ICC sent them,
  // and one which takes long must not be passed by the next. ICC gives them the same queue: the commands of a queue
  // run one at a time, in the order they arrived. ICC also repeats a command which did not answer in time: within a
  // queue, a command which repeats the last one, while that one still runs, joins it. Only the last one: after
  // another command, the same command is a new request, and runs after it. Without a queue every command runs at
  // once, on its own.
  function sendApplicationCommand ({ application = null, name, payload = {}, queue = null } = {}) {
    if (typeof name !== 'string' || !name.startsWith(COMMAND_PREFIX)) {
      return Promise.reject(new Error(`The name of an application command must start with "${COMMAND_PREFIX}"`))
    }

    if (queue === null || queue === undefined) {
      return runCommand(application, name, payload)
    }

    if (typeof queue !== 'string' || queue === '') {
      return Promise.reject(new Error('The queue of an application command must be a string'))
    }

    const key = JSON.stringify([application, name, payload])
    const state = queues.get(queue) ?? { tail: Promise.resolve(), last: null }
    queues.set(queue, state)

    if (state.last?.key === key && !state.last.settled) {
      return state.last.running
    }

    const entry = { key, settled: false, running: null }
    const settle = () => { entry.settled = true }

    entry.running = state.tail.then(() => runCommand(application, name, payload))
    entry.running.then(settle, settle)
    state.tail = entry.running.catch(() => {})
    state.last = entry

    return entry.running
  }

  async function runCommand (application, name, payload) {
    let ids = applicationIds()

    if (application !== null) {
      if (!ids.includes(application)) {
        throw new Error(`The application "${application}" is not an application of the runtime`)
      }

      ids = [application]
    }

    const applications = {}
    const skipped = new Set()
    const errors = {}
    const asked = {}

    await Promise.all(ids.map(async id => {
      const type = typeOf(id)

      try {
        const result = await app.watt.runtime.sendCommandToApplication(id, name, payload)

        if (isUnhandled(result)) {
          skipped.add(id)
        } else {
          // A handler which returns nothing answered: JSON has no undefined
          applications[id] = result ?? null
        }
      } catch (err) {
        errors[id] = err.message
      }

      asked[id] = await type
    }))

    // In the order of the runtime, whichever answered first
    return { applications, skipped: ids.filter(id => skipped.has(id)), errors, types: Object.fromEntries(ids.map(id => [id, asked[id]])) }
  }

  app.sendApplicationCommand = sendApplicationCommand
}

export default applicationCommands
