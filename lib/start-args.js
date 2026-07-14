import minimist from 'minimist'
import { resolve } from 'node:path'

// Parse start command argv and apply CLI options to env.
// Precedence for PLT_LOG_LEVEL: --log-level flag > pre-set env > 'info' default.
// Do NOT add a minimist default for `log-level`: that would make args['log-level']
// always truthy and unconditionally clobber an env-provided value.
export function applyStartArgs (argv, env = process.env) {
  const args = minimist(argv, {
    alias: {
      h: 'help',
      l: 'log-level',
      i: 'icc-url',
      a: 'app-name',
      d: 'app-dir'
    },
    boolean: ['help'],
    string: ['log-level', 'icc-url', 'app-name', 'app-dir'],
    default: {
      'app-dir': process.cwd()
    }
  })

  if (args.help) {
    return { args, help: true }
  }

  if (args['log-level']) {
    env.PLT_LOG_LEVEL = args['log-level']
  } else if (!env.PLT_LOG_LEVEL) {
    env.PLT_LOG_LEVEL = 'info'
  }

  if (args['icc-url']) {
    env.PLT_ICC_URL = args['icc-url']
  }

  if (args['app-name']) {
    env.PLT_APP_NAME = args['app-name']
  }

  if (args['app-dir']) {
    env.PLT_APP_DIR = resolve(args['app-dir']) // Ensure the path is absolute
  }

  return { args, help: false }
}
