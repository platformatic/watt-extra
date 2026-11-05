export default {
  module: '@platformatic/service',
  server: { hostname: '127.0.0.1', port: Number(process.env.PLT_APP_PORT ?? 3042), logger: { level: 'silent' }, keepAliveTimeout: 1 },
  service: { openapi: true },
  plugins: { paths: ['./routes'] }
}
