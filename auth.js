import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Alexa+ authenticates service-level calls with OAuth 2.0 client_credentials:
// HTTP Basic client auth, a `resource` equal to this server's canonical MCP
// URI, scope mcp:service, tokens of at most 3600s and no refresh token.
// A static token is also accepted, for local testing with curl or rote.

const SCOPE = 'mcp:service';
const TOKEN_TTL_S = 3600;

// A malformed %-escape in Basic credentials must be a 401, not a thrown URIError (500).
function decode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function configureAuth(env) {
  const staticToken = env.VOICEPLAYS_TOKEN ?? '';
  const clientId = env.VOICEPLAYS_CLIENT_ID ?? '';
  const clientSecret = env.VOICEPLAYS_CLIENT_SECRET ?? '';
  const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  const oauth = Boolean(clientId && clientSecret && publicUrl);

  const problems = [];
  if (staticToken && staticToken.length < 32) problems.push('VOICEPLAYS_TOKEN must be at least 32 characters (openssl rand -hex 32).');
  if ((clientId || clientSecret) && !oauth) problems.push('OAuth needs all three of VOICEPLAYS_CLIENT_ID, VOICEPLAYS_CLIENT_SECRET and PUBLIC_URL.');
  if (clientSecret && clientSecret.length < 32) problems.push('VOICEPLAYS_CLIENT_SECRET must be at least 32 characters (openssl rand -hex 32).');
  if (!staticToken && !oauth) problems.push('Set VOICEPLAYS_TOKEN for local use, or VOICEPLAYS_CLIENT_ID, VOICEPLAYS_CLIENT_SECRET and PUBLIC_URL for Alexa+.');
  if (problems.length) return { problems };

  const resource = `${publicUrl}/mcp`;
  const issued = new Map();

  function sweep() {
    const now = Date.now();
    for (const [t, exp] of issued) if (exp <= now) issued.delete(t);
  }

  function authorised(req) {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    if (staticToken && same(token, staticToken)) return true;
    const exp = issued.get(token);
    return exp !== undefined && exp > Date.now();
  }

  const router = express.Router();

  if (oauth) {
    router.get('/.well-known/oauth-protected-resource', (req, res) => {
      res.json({ resource, authorization_servers: [publicUrl], scopes_supported: [SCOPE] });
    });

    router.get('/.well-known/oauth-authorization-server', (req, res) => {
      res.json({
        issuer: publicUrl,
        token_endpoint: `${publicUrl}/oauth/token`,
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        scopes_supported: [SCOPE]
      });
    });

    router.post('/oauth/token', express.urlencoded({ extended: false }), (req, res) => {
      const fail = (status, error) => res.status(status).json({ error });
      if (Object.keys(req.query).length) return fail(400, 'invalid_request');

      const basic = req.get('authorization') ?? '';
      const [id, secret] = basic.startsWith('Basic ')
        ? Buffer.from(basic.slice(6), 'base64').toString().split(/:(.*)/s)
        : [];
      const givenId = id && decode(id);
      const givenSecret = secret && decode(secret);
      if (!givenId || !givenSecret || !same(givenId, clientId) || !same(givenSecret, clientSecret)) {
        res.set('WWW-Authenticate', 'Basic');
        return fail(401, 'invalid_client');
      }

      const { grant_type, scope, resource: asked } = req.body ?? {};
      if (grant_type !== 'client_credentials') return fail(400, 'unsupported_grant_type');
      if (asked !== resource) return fail(400, 'invalid_target');
      if (scope && !scope.split(' ').every(s => s === SCOPE)) return fail(400, 'invalid_scope');

      sweep();
      const token = randomBytes(32).toString('hex');
      issued.set(token, Date.now() + TOKEN_TTL_S * 1000);
      res.set('Cache-Control', 'no-store');
      res.json({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: SCOPE });
    });
  }

  router.use('/mcp', (req, res, next) => {
    if (authorised(req)) return next();
    res.set('WWW-Authenticate', oauth
      ? `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", scope="${SCOPE}"`
      : 'Bearer');
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  });

  return { router, oauth, publicHostname: publicUrl ? new URL(publicUrl).hostname : null };
}
