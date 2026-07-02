/**
 * The storage *contract*: what any file-storage backend must be able to do for
 * a chunked ("multipart") upload. The routes depend on THIS interface, not on
 * R2 directly — so tests swap in a fake and the real server swaps in R2.
 */

/** One finished chunk, as reported back by the browser after it uploaded. */
export interface UploadPartRef {
  /** 1-based index of the chunk. */
  partNumber: number
  /** The fingerprint R2 returned for that chunk (its `ETag` response header). */
  etag: string
}

/**
 * One chunk R2 already holds for an in-progress upload, as reported by
 * `listParts`. Same shape as UploadPartRef plus the byte size R2 recorded —
 * handy for a resuming client to double-check a part landed whole.
 */
export interface UploadedPart {
  partNumber: number
  etag: string
  size: number
}

export interface MultipartStorage {
  /** Begin a multipart upload for `key`; returns R2's upload id. */
  start(input: { key: string; contentType: string }): Promise<{ uploadId: string }>

  /** Produce a temporary signed URL the browser can PUT one chunk to. */
  presignPart(input: { key: string; uploadId: string; partNumber: number }): Promise<string>

  /**
   * Ask R2 which chunks it has already received for an in-progress upload.
   * This is what lets a resumed upload skip the parts that already landed
   * instead of starting over — R2 is the source of truth, not the browser.
   */
  listParts(input: { key: string; uploadId: string }): Promise<UploadedPart[]>

  /** Stitch the uploaded chunks into the final object. */
  complete(input: { key: string; uploadId: string; parts: UploadPartRef[] }): Promise<void>
}

/**
 * A simple read/write/list interface for small JSON files in storage — used for
 * project files, NOT the big video chunks. Like MultipartStorage, the routes
 * depend on this contract so tests can swap in an in-memory fake.
 */
export interface ObjectStore {
  /** Store `value` as a JSON file at `key` (overwrites if it already exists). */
  putJson(key: string, value: unknown): Promise<void>
  /** Read a JSON file back from `key`, or null if nothing is there. */
  getJson<T>(key: string): Promise<T | null>
  /** List every key that starts with `prefix`. */
  listKeys(prefix: string): Promise<string[]>
  /**
   * Produce a temporary signed URL the browser can GET to download the object
   * at `key` directly from storage (the read-twin of `presignPart`). Used for
   * download-on-demand of media bytes on a device that doesn't have them yet.
   */
  presignGet(key: string): Promise<string>
}
