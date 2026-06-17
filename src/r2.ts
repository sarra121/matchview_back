/**
 * Real R2-backed storage, using the AWS S3 SDK pointed at Cloudflare.
 * R2 speaks S3's API; nothing here touches Amazon — files live in your R2 bucket.
 *
 * Two factories are built here, both sharing the same client settings:
 *   - createR2Storage     → the chunked-upload contract (MultipartStorage)
 *   - createR2ObjectStore → the read/write/list-JSON contract (ObjectStore)
 */

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { MultipartStorage, ObjectStore } from './storage.ts'

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** How long a presigned chunk URL stays valid, in seconds. Default 1 hour. */
  presignExpirySeconds?: number
}

/** Build one configured S3 client for R2. Shared by both factories below. */
function buildClient(cfg: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // Newer AWS SDK versions attach an extra checksum tag to every request.
    // Cloudflare R2 rejects that tag, so only add it when an operation truly
    // requires it (ours never do).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

export function createR2Storage(cfg: R2Config): MultipartStorage {
  const client = buildClient(cfg)
  const expiresIn = cfg.presignExpirySeconds ?? 3600

  return {
    async start({ key, contentType }) {
      const out = await client.send(
        new CreateMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }),
      )
      if (!out.UploadId) {
        throw new Error('R2 did not return an UploadId for the multipart upload')
      }
      return { uploadId: out.UploadId }
    },

    async presignPart({ key, uploadId, partNumber }) {
      // Builds the URL but sends no request — the signature is computed locally,
      // then the browser uses the URL to PUT the chunk straight to R2.
      return getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn },
      )
    },

    async complete({ key, uploadId, parts }) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: cfg.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            // R2 requires the parts listed in ascending part-number order.
            Parts: parts
              .slice()
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      )
    },
  }
}

/** True when an S3 error means "that key doesn't exist". */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'NoSuchKey'
  )
}

export function createR2ObjectStore(cfg: R2Config): ObjectStore {
  const client = buildClient(cfg)

  return {
    async putJson(key, value) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: JSON.stringify(value),
          ContentType: 'application/json',
        }),
      )
    },

    async getJson(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
        if (!out.Body) return null
        // `Body` is a stream; transformToString reads it fully into text.
        const text = await out.Body.transformToString()
        return JSON.parse(text)
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },

    async listKeys(prefix) {
      const keys: string[] = []
      let token: string | undefined
      // R2 returns at most 1000 keys per call, so loop until there are no more.
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
        )
        for (const obj of out.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key)
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined
      } while (token)
      return keys
    },
  }
}
