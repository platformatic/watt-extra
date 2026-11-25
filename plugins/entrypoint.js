const GATEWAY_TYPES = new Set(['gateway', '@platformatic/gateway'])

function getUrlPort (url) {
  const { port, protocol } = new URL(url)
  if (port) return Number(port)
  return protocol === 'https:' ? 443 : 80
}

function findEntrypoints (applications, routedPorts) {
  const routedIds = []
  const gatewayIds = []
  const listeningIds = []

  for (const { id, type, urls = [] } of applications) {
    if (urls.length === 0) continue
    listeningIds.push(id)

    if (GATEWAY_TYPES.has(type)) {
      gatewayIds.push(id)
    }

    const applicationPorts = urls.map(getUrlPort)
    const isRouted = routedPorts.some(
      ({ targetPort }) => applicationPorts.includes(targetPort)
    )
    if (isRouted) {
      routedIds.push(id)
    }
  }

  if (routedIds.length > 0) return routedIds
  if (gatewayIds.length > 0) return gatewayIds
  return listeningIds
}

async function entrypoint (app, _opts) {
  let entrypoints = null

  app.getEntrypoints = async () => {
    if (entrypoints !== null) return entrypoints

    const { applications } = await app.watt.runtime.getApplications()
    const routedPorts = app.instanceConfig?.ports ?? []

    entrypoints = findEntrypoints(applications, routedPorts)

    app.log.info({ entrypoints, routedPorts }, 'Resolved the entrypoint applications')
    return entrypoints
  }
}

export default entrypoint
