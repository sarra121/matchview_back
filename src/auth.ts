import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, jwtVerify } from 'jose' 


export interface AuthConfig {
    domain: string;
    audience: string
}

/**
 * The shape of a request's context AFTER this middleware runs: it carries a
 * string `userId`. Routers/handlers type themselves with this so `c.get('userId')`
 * is known to be a string. Defined once here, imported wherever it's needed.
 */
export type AuthEnv = { Variables: { userId: string } }

/**
 * The one job the middleware can't do itself: turn a raw bearer token into the
 * caller's userId, or throw if the token is no good. This is the seam tests
 * replace with a fake so routes can be exercised without a real Auth0 JWT.
 */
export type TokenVerifier = (token: string) => Promise<{ userId: string }>

/**
 * The REAL verifier: checks an Auth0-issued JWT against Auth0's public keys.
 * Built once (the JWKS fetch is set up here), then reused for every request.
 */
export function createAuth0Verifier(config: AuthConfig): TokenVerifier {
    const jwks = createRemoteJWKSet(
        new URL(`https://${config.domain}/.well-known/jwks.json`)
    )

    return async (token) => {
        const { payload } = await jwtVerify(token, jwks, {
            issuer: `https://${config.domain}/`,
            audience: config.audience,
        })
        if (!payload.sub) throw new Error('token has no subject')
        return { userId: sanitizeUserId(payload.sub) }
    }
}

/**
 * Build the auth gate around a token verifier (the real Auth0 one by default;
 * a fake in tests). The middleware only handles the HTTP plumbing — pull the
 * Bearer token, hand it to `verify`, stash the userId, or 401 on any failure.
 */
export function createAuthMiddleware(verify: TokenVerifier) {
    return createMiddleware<AuthEnv>(async (c, next) => {
        const header = c.req.header('authorization') ?? ''
        const token = header.startsWith('Bearer ') ? header.slice(7) : ''
        if (!token) return c.json({ error: 'missing token' }, 401)

        try {
            const { userId } = await verify(token)
            c.set('userId', userId)
            await next()
        } catch {
            return c.json({ error: 'invalid token' }, 401)
        }
    })
}
        



function sanitizeUserId(sub : string): string {
    return sub.replace(/[^A-Za-z0-9_-]/g, '_')
} 


