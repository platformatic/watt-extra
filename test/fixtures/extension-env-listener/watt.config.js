export default {
  module: '@platformatic/service',
  server: { hostname: '127.0.0.1', port: Number(process.env.PLT_APP_PORT ?? 0) },
  plugins: { paths: ['../extension-service/plugin.js'] }
}
