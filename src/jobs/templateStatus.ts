import type { PayloadRequest, TaskConfig } from 'payload'

import type { MetaHost } from '../types/host'
import { checkPendingTemplates } from '../templates/sync'

type TemplateStatusOutput = {
    input: Record<string, never>
    output: { checked: number; changed: number; retried: number }
}

/**
 * Keep asking Meta about the templates still in review, and try again the ones that could not be submitted.
 *
 * Meta tells the webhook when a template is approved or rejected, and that is the fast path. This is the safety net: until the
 * callback is registered on the Meta app, or if a delivery is lost, a template would otherwise stay "in review" for ever.
 */
export function createTemplateStatusJob(host?: MetaHost): TaskConfig<TemplateStatusOutput> {
    return {
        slug: 'meta-template-status',
        schedule: [{ cron: '*/5 * * * *', queue: 'default' }],
        inputSchema: [],
        outputSchema: [
            { name: 'checked', type: 'number' },
            { name: 'changed', type: 'number' },
            { name: 'retried', type: 'number' },
        ],
        retries: 0,
        handler: async ({ req }: { req: PayloadRequest }) => {
            try {
                const output = await checkPendingTemplates({ payload: req.payload, req, host })
                if (output.changed > 0 || output.retried > 0) {
                    req.payload.logger.info(`[meta:templates] checked ${output.checked}, changed ${output.changed}, retried ${output.retried}`)
                }
                return { output }
            } catch (err) {
                req.payload.logger.warn(`[meta:templates] this check was skipped (${err instanceof Error ? err.message : err})`)
                return { output: { checked: 0, changed: 0, retried: 0 } }
            }
        },
    }
}
