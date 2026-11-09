export default {
  module: '@platformatic/next', server: { hostname: '127.0.0.1', port: 3043 },
  cache: { adapter: 'valkey', url: 'valkey://127.0.0.1:6390', cacheComponents: true }
}
