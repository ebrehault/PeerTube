// FIXME: https://github.com/nodejs/node/pull/16853
require('tls').DEFAULT_ECDH_CURVE = 'auto'

import { isTestInstance } from './server/helpers/core-utils'

if (isTestInstance()) {
  require('source-map-support').install()
}

// ----------- Node modules -----------
import * as bodyParser from 'body-parser'
import * as express from 'express'
import * as morgan from 'morgan'
import * as cors from 'cors'
import * as cookieParser from 'cookie-parser'

process.title = 'peertube'

// Create our main app
const app = express()

// ----------- Core checker -----------
import { checkMissedConfig, checkFFmpeg, checkConfig, checkActivityPubUrls } from './server/initializers/checker'

// Do not use barrels because we don't want to load all modules here (we need to initialize database first)
import { logger } from './server/helpers/logger'
import { API_VERSION, CONFIG, STATIC_PATHS } from './server/initializers/constants'

const missed = checkMissedConfig()
if (missed.length !== 0) {
  logger.error('Your configuration files miss keys: ' + missed)
  process.exit(-1)
}

checkFFmpeg(CONFIG)
  .catch(err => {
    logger.error('Error in ffmpeg check.', { err })
    process.exit(-1)
  })

const errorMessage = checkConfig()
if (errorMessage !== null) {
  throw new Error(errorMessage)
}

// Trust our proxy (IP forwarding...)
app.set('trust proxy', CONFIG.TRUST_PROXY)

// ----------- Database -----------

// Initialize database and models
import { initDatabaseModels } from './server/initializers/database'
import { migrate } from './server/initializers/migrator'
migrate()
  .then(() => initDatabaseModels(false))
  .then(() => startApplication())
  .catch(err => {
    logger.error('Cannot start application.', { err })
    process.exit(-1)
  })

// ----------- PeerTube modules -----------
import { installApplication } from './server/initializers'
import { Emailer } from './server/lib/emailer'
import { JobQueue } from './server/lib/job-queue'
import { VideosPreviewCache } from './server/lib/cache'
import {
  activityPubRouter,
  apiRouter,
  clientsRouter,
  feedsRouter,
  staticRouter,
  servicesRouter,
  webfingerRouter,
  trackerRouter,
  createWebsocketServer
} from './server/controllers'
import { Redis } from './server/lib/redis'
import { BadActorFollowScheduler } from './server/lib/schedulers/bad-actor-follow-scheduler'
import { RemoveOldJobsScheduler } from './server/lib/schedulers/remove-old-jobs-scheduler'
import { UpdateVideosScheduler } from './server/lib/schedulers/update-videos-scheduler'

// ----------- Command line -----------

// ----------- App -----------

// Enable CORS for develop
if (isTestInstance()) {
  app.use((req, res, next) => {
    // These routes have already cors
    if (
      req.path.indexOf(STATIC_PATHS.TORRENTS) === -1 &&
      req.path.indexOf(STATIC_PATHS.WEBSEED) === -1
    ) {
      return (cors({
        origin: '*',
        exposedHeaders: 'Retry-After',
        credentials: true
      }))(req, res, next)
    }

    return next()
  })
}

// For the logger
app.use(morgan('combined', {
  stream: { write: logger.info.bind(logger) }
}))
// For body requests
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json({
  type: [ 'application/json', 'application/*+json' ],
  limit: '500kb'
}))
// Cookies
app.use(cookieParser())

// ----------- Views, routes and static files -----------

// API
const apiRoute = '/api/' + API_VERSION
app.use(apiRoute, apiRouter)

// Services (oembed...)
app.use('/services', servicesRouter)

app.use('/', activityPubRouter)
app.use('/', feedsRouter)
app.use('/', webfingerRouter)
app.use('/', trackerRouter)

// Static files
app.use('/', staticRouter)

// Client files, last valid routes!
app.use('/', clientsRouter)

// ----------- Errors -----------

// Catch 404 and forward to error handler
app.use(function (req, res, next) {
  const err = new Error('Not Found')
  err['status'] = 404
  next(err)
})

app.use(function (err, req, res, next) {
  let error = 'Unknown error.'
  if (err) {
    error = err.stack || err.message || err
  }

  logger.error('Error in controller.', { error })
  return res.status(err.status || 500).end()
})

const server = createWebsocketServer(app)

// ----------- Run -----------

async function startApplication () {
  const port = CONFIG.LISTEN.PORT
  const hostname = CONFIG.LISTEN.HOSTNAME

  await installApplication()

  // Check activity pub urls are valid
  checkActivityPubUrls()
    .catch(err => {
      logger.error('Error in ActivityPub URLs checker.', { err })
      process.exit(-1)
    })

  // Email initialization
  Emailer.Instance.init()
  await Emailer.Instance.checkConnectionOrDie()

  await JobQueue.Instance.init()

  // Caches initializations
  VideosPreviewCache.Instance.init(CONFIG.CACHE.PREVIEWS.SIZE)

  // Enable Schedulers
  BadActorFollowScheduler.Instance.enable()
  RemoveOldJobsScheduler.Instance.enable()
  UpdateVideosScheduler.Instance.enable()

  // Redis initialization
  Redis.Instance.init()

  // Make server listening
  server.listen(port, hostname, () => {
    logger.info('Server listening on %s:%d', hostname, port)
    logger.info('Web server: %s', CONFIG.WEBSERVER.URL)
  })
}
