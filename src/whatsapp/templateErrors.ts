/**
 * Cloud API send failures that are about the template a message names.
 *
 * Returns null when the failure is something else, so the caller keeps its own wording. A template that is still with Meta
 * for review is retryable: the message stays queued and goes out once it is approved. A template that is missing, paused or
 * rejected is reported the same way, because from the sender's side it is "not usable yet".
 */
export function explainTemplateSendError(body: string): { retryable: boolean; error: string } | null {
    const aboutTemplate = /template/i.test(body) || /132001|132015|132016/.test(body)
    if (!aboutTemplate) return null
    const waiting = /not approved|pending review|is pending|\bpending\b|does not exist|doesn't exist|not exist|paused|disabled|132001|132015|132016/i.test(body)
    if (waiting) {
        return {
            retryable: true,
            error: "This message's template is not approved by Meta yet. It will send after it is approved.",
        }
    }
    return {
        retryable: false,
        error: 'Meta could not send this message from its template.',
    }
}
