// What ICC asks the applications of the pod, and what it tells them when they start. watt-extra carries both and
// knows the meaning of neither: the applications, or their capabilities, do, and so does ICC.
//
// While the pod runs, ICC sends commands to the applications: the "application-command" command, with the name of a
// message the applications handle through the ITC of the runtime, and its payload. The answers go back as they are.
//
// When the pod starts, ICC tells what it knows of the deployment, i.e. whether its version is staged: the context,
// an object in the configuration of the instance, or in its refusal of the registration. It is given to every
// application as JSON, in an environment variable, and each reads what it needs.
//
// Everything here is optional: an ICC which sends no context and no command changes nothing.
//
// What must be upgraded first: ICC, then the images. An ICC which predates the context tells whether a version is
// staged in another way, which this watt-extra does not read, and sends commands it does not have. And an application
// must read the context for it to mean anything: a capability which was configured by an earlier watt-extra, and does
// not read the variable, starts as if ICC had told nothing. Ship this watt-extra with capabilities which read it.

export const APPLICATION_COMMAND = 'application-command'

// Only the messages of the capabilities of Platformatic are forwarded
export const COMMAND_PREFIX = 'plt:'

export const CONTEXT_VARIABLE = 'PLT_DEPLOYMENT_CONTEXT'

// What this watt-extra can do, told to ICC when it connects, in the query of the URL: ICC chooses from it how to
// speak to the pod, i.e. an ICC which knows the commands of an older watt-extra sends those to a pod which does not
// tell this
export const CAPABILITIES = ['application-command']

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// The context ICC gave with the configuration of the instance, or with its refusal, or null
export function contextOf (source) {
  return isObject(source?.context) ? source.context : null
}

// What ICC told when it refused the registration of the pod, as { context }, or null. The error of the client carries
// the body of the response: ICC adds the context to its refusals, i.e. the 4xx answers, since a pod it does not accept
// starts all the same, and must start as ICC wants it. Any other failure, an ICC which cannot be reached, which fails,
// or which sends no context, says nothing, and nothing changes.
export function refusedContext (err) {
  let body

  try {
    body = JSON.parse(err?.message)
  } catch {
    return null
  }

  if (!isObject(body) || !(body.statusCode >= 400 && body.statusCode < 500)) {
    return null
  }

  const context = contextOf(body)
  return context ? { context } : null
}
