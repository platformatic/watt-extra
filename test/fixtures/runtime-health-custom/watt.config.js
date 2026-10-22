export default {
  extensions: [{ path: '../../../index.js' }],
  autoload: { path: 'services' }, watch: true, logger: { level: 'error' },
  health: { enabled: true, interval: 2500, maxUnhealthyChecks: 50 }
}
