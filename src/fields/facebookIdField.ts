import type { CollectionConfig, Field } from 'payload'

/**
 * The link between a platform account and a Facebook account: Facebook's own id for the person.
 *
 * Only the sign-in code writes it (a person's own request cannot set it: that would let anyone claim another Facebook account), and
 * only the account's owner or the platform owner can read it. One Facebook account can belong to one platform account (unique).
 */
export const facebookIdField = {
    name: 'facebookId',
    type: 'text',
    unique: true,
    index: true,
    access: {
        create: () => false,
        update: () => false,
        read: ({ req, doc }) => {
            const user = req.user as { id?: number | string; role?: string } | null
            if (!user) return false
            return user.role === 'super-admin' || (doc?.id !== undefined && String(doc.id) === String(user.id))
        },
    },
    admin: {
        readOnly: true,
        position: 'sidebar',
        description: 'Set when this person signs in with Facebook and the email matches. To disconnect it, they use "Disconnect Facebook".',
    },
} satisfies Field & { name: string }

/** Adds the Facebook link to the collection people sign in to. Any other collection is returned as it was. */
export function attachFacebookLogin(collection: CollectionConfig, usersSlug: string): CollectionConfig {
    if (collection.slug !== usersSlug) return collection
    if (collection.fields.some((field) => 'name' in field && field.name === facebookIdField.name)) return collection
    return { ...collection, fields: [...collection.fields, facebookIdField] }
}
