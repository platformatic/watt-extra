import config from './service.config.js'

export default {
  applications: [{ id: 'main', path: '.', config }],
  extensions: [{ path: '../../../index.js' }]
}
