export default {
  module: '@platformatic/gateway', server: { hostname: '127.0.0.1', port: 3042 },
  gateway: { applications: [{ id: 'beta', proxy: { prefix: '/2' } }, { id: 'alpha', proxy: { prefix: '/1' } }] }
}
