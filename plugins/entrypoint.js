const GATEWAY_TYPES = new Set(['gateway', '@platformatic/gateway'])

function getUrlPort (url) {
  const { port, protocol } = new URL(url)
  if (port) return Number(port)
  return protocol === 'https:' ? 443 : 80
}

// The first listening gateway; else the only listening application; else the first one on a routed port. Without
// the routed ports, several listening applications have no entrypoint.
function findEntrypoint (applications, routedPorts, log) {
  const listeningApplications = []
  for (const { id, type, urls = [] } of applications) {
    if (urls.length === 0) continue
    if (GATEWAY_TYPES.has(type)) return id

    const applicationPorts = urls.map(getUrlPort)
    listeningApplications.push({ id, ports: applicationPorts })
  }

  if (listeningApplications.length === 1) {
    return listeningApplications[0].id
  }

  for (const { id, ports } of listeningApplications) {
    const isRouted = routedPorts.some(({ targetPort }) => ports.includes(targetPort))
    if (isRouted) return id
  }

  if (listeningApplications.length > 1) {
    const applicationIds = listeningApplications.map(({ id }) => id)
    log.warn(
      { applicationIds, routedPorts },
      'Cannot resolve the entrypoint: several applications listen and none is a gateway or on a routed port'
    )
  }
  return null
}

async function entrypoint (app, _opts) {
  // Resolved once, on the first call: it needs the started runtime (the listening URLs) and the instance config
  // (the routed ports), so it must not be called before both
  let isEntrypointResolved = false
  let entrypoint = null

  app.getEntrypoint = async () => {
    if (isEntrypointResolved) return entrypoint

    const { applications } = await app.watt.runtime.getApplications()
    const routedPorts = app.instanceConfig?.ports ?? []

    entrypoint = findEntrypoint(applications, routedPorts, app.log)
    isEntrypointResolved = true

    app.log.info({ entrypoint, routedPorts }, 'Resolved the entrypoint application')
    return entrypoint
  }
}

export default entrypoint
