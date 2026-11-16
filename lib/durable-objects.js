// The Durable Objects of Lavoratore applications (@platformatic/lavoratore), orchestrated by ICC: see
// docs/durable-objects.md of Lavoratore. Everything here is optional: an ICC which knows nothing of Durable Objects
// sends no `durableObjects` with the instance config and no command, and nothing changes.

export const LAVORATORE_TYPES = ['@platformatic/lavoratore', 'lavoratore']

// The ITC commands handled by the Lavoratore applications, with the same names and payloads as their runtime messages
export const COMMANDS = {
  'durable-objects-promote': 'plt:lavoratore:promote',
  'durable-objects-drain': 'plt:lavoratore:drain'
}

export function isLavoratoreApplication (application) {
  return LAVORATORE_TYPES.includes(application?.type)
}

// The configuration patch of a Lavoratore application under ICC, or null when ICC said nothing about Durable Objects:
// a pod of a staged version receives no objects until ICC promotes it, with the generation of the approval
export function durableObjectsPatch (instanceConfig) {
  const durableObjects = instanceConfig?.durableObjects

  if (!durableObjects || typeof durableObjects !== 'object') {
    return null
  }

  return [
    {
      op: 'merge',
      path: '/lavoratore/durableObjects/placement',
      value: { promoted: durableObjects.staged !== true }
    }
  ]
}

// The result of a promotion of every Lavoratore application of the pod: promoted when all are
export function aggregatePromotion (results) {
  const applications = Object.values(results)
  return { promoted: applications.length > 0 && applications.every(result => result.promoted === true), applications: results }
}

// The status of a drain of every Lavoratore application of the pod: draining while any is, drained when all are,
// blocked when none is partial and some are blocked, partial otherwise
export function aggregateDrain (results) {
  const statuses = Object.values(results).map(result => result.status)
  let status = 'partial'

  if (statuses.some(value => value === 'draining')) {
    status = 'draining'
  } else if (statuses.length > 0 && statuses.every(value => value === 'drained')) {
    status = 'drained'
  } else if (statuses.length > 0 && statuses.every(value => value === 'drained' || value === 'blocked')) {
    status = 'blocked'
  }

  return { status, applications: results }
}
