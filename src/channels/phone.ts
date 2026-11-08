/**
 * Normalise a human-typed phone number to bare E.164 digits (no `+`), which is what the Cloud API takes as `to`.
 *
 * Website forms collect whatever the visitor types ("0803 123 4567", "+234 803 123 4567", "234-803-123-4567"). Returns the
 * input's digits unchanged when it cannot confidently expand them: better to attempt a send with what the user gave than to
 * mangle a number from a country whose format is not known.
 */
export function toE164Digits(phone: string, defaultCountryCode?: string): string {
    const trimmed = phone.trim()
    // A leading + (or the 00 international prefix) means the caller already qualified the number.
    if (trimmed.startsWith('+')) return trimmed.replace(/\D/g, '')

    const digits = trimmed.replace(/\D/g, '')
    if (!digits) return ''
    if (digits.startsWith('00')) return digits.slice(2)

    const cc = (defaultCountryCode ?? '').replace(/\D/g, '')
    if (!cc) return digits

    // Already international for this country. The length guard stops a national number that happens to begin with the
    // country's own digits from being left un-prefixed.
    if (digits.startsWith(cc) && digits.length > cc.length + 6) return digits

    // National trunk prefix: "0803..." -> "<cc>803...".
    if (digits.startsWith('0')) return cc + digits.slice(1)

    // Bare national significant number, no trunk prefix ("8031234567").
    if (digits.length <= 11) return cc + digits

    return digits
}
