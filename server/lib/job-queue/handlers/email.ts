import * as kue from 'kue'
import { logger } from '../../../helpers/logger'
import { Emailer } from '../../emailer'

export type EmailPayload = {
  to: string[]
  subject: string
  text: string
}

async function processEmail (job: kue.Job) {
  const payload = job.data as EmailPayload
  logger.info('Processing email in job %d.', job.id)

  return Emailer.Instance.sendMail(payload.to, payload.subject, payload.text)
}

// ---------------------------------------------------------------------------

export {
  processEmail
}
