import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const options = {
  help: { type: 'boolean', short: 'h' },
  'log-level': { type: 'string', short: 'l' },
  'icc-url': { type: 'string', short: 'i' },
  'app-name': { type: 'string', short: 'a' },
  'app-dir': { type: 'string', short: 'd' }
}

const stringOptions = {
  '--log-level': '-l',
  '--icc-url': '-i',
  '--app-name': '-a',
  '--app-dir': '-d'
}

function validateStringOptions (argv) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]

    for (const [longOption, shortOption] of Object.entries(stringOptions)) {
      if (arg === longOption || arg === shortOption) {
        const value = argv[index + 1]
        if (!value || value.startsWith('-')) {
          throw new Error(`Option "${arg}" requires a value`)
        }
        index++
        break
      }

      if (arg === `${longOption}=`) {
        throw new Error(`Option "${longOption}" requires a value`)
      }
    }
  }
}

// Parse start command argv and apply CLI options to env.
// Precedence for PLT_LOG_LEVEL: --log-level flag > pre-set env > 'info' default.
// Do NOT add a parseArgs default for `log-level`: that would make args['log-level']
// always truthy and unconditionally clobber an env-provided value.
export function applyStartArgs (argv, env = process.env) {
  validateStringOptions(argv)

  const { values: args } = parseArgs({
    args: argv,
    options,
    strict: true,
    allowPositionals: false
  })

  if (args.help) {
    return { args, help: true }
  }

  const logLevel = args['log-level']
  if (logLevel) {
    env.PLT_LOG_LEVEL = logLevel
  } else if (!env.PLT_LOG_LEVEL) {
    env.PLT_LOG_LEVEL = 'info'
  }

  const iccUrl = args['icc-url']
  if (iccUrl) {
    env.PLT_ICC_URL = iccUrl
  }

  const appName = args['app-name']
  if (appName) {
    env.PLT_APP_NAME = appName
  }

  const appDir = args['app-dir'] ?? process.cwd()
  if (appDir) {
    env.PLT_APP_DIR = resolve(appDir) // Ensure the path is absolute
  }

  return { args, help: false }
}
