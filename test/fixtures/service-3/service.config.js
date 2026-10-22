export default {
  module: '@platformatic/service',
  server: { hostname: '127.0.0.1', port: 3042, logger: { level: 'silent' }, keepAliveTimeout: 1 },
  service: { openapi: true },
  plugins: { paths: ['./routes'] }
}
