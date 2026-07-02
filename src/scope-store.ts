import type { MultipartStorage, ObjectStore } from './storage.ts'

/**
 * Wraps an ObjectStore so every key is silently prefixed with `users/<userId>/`.
 * A handler uses the returned store exactly like the real one, but it can only
 * ever read/write the calling user's slice of the bucket.
 */
export function scopeStore(objects: ObjectStore, userId: string): ObjectStore {
  const prefix = `users/${userId}/`
  return {
    // writes/reads/download-urls: just glue the prefix on before passing through
    putJson: (key, value) => objects.putJson(prefix + key, value),
    getJson: <T>(key: string) => objects.getJson<T>(prefix + key),
    presignGet: (key) => objects.presignGet(prefix + key),

    // listing: prefix the search, then strip the prefix back OFF the results so
    // the handler sees normal-looking keys and never has to know about `users/…`
    listKeys: async (p) => {
      const keys = await objects.listKeys(prefix + p)
      return keys.map((k) => k.slice(prefix.length))
    },
  }
}

/**
 * Same idea as scopeStore, but for the multipart (big video bytes) storage.
 * Every key passed in gets `users/<userId>/` glued on before reaching R2, so a
 * user's uploaded bytes land in — and can only be reached from — their own
 * folder. Callers keep passing UNPREFIXED keys; the prefix lives only here.
 */
export function scopeMultipart(storage: MultipartStorage, userId: string): MultipartStorage {
  const prefix = `users/${userId}/`
  return {
    start: (input) => storage.start({ ...input, key: prefix + input.key }),
    presignPart: (input) => storage.presignPart({ ...input, key: prefix + input.key }),
    listParts: (input) => storage.listParts({ ...input, key: prefix + input.key }),
    complete: (input) => storage.complete({ ...input, key: prefix + input.key }),
  }
}