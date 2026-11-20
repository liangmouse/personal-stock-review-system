import {
  oauthAuthorizationMetadata,
  oauthIssuer,
  protectedResourceMetadata,
} from './oauth-http';

export function metadataResponse(kind: 'authorization-server' | 'protected-resource') {
  const issuer = oauthIssuer();
  if (!issuer) {
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }
  const body = kind === 'authorization-server'
    ? oauthAuthorizationMetadata(issuer)
    : protectedResourceMetadata(issuer);
  return Response.json(body, {
    headers: { 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' },
  });
}
