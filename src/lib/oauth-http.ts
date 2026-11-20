import {
  authorizationVersion,
  chatGptRedirectUri,
  oauthAuthorizationServerIssuer,
  oauthClientId,
  oauthResource as getOAuthResource,
} from './oauth-store';
import { hasValidWebPassword } from './session-token';

export const journalOAuthClientId = oauthClientId;
export const chatGptOAuthRedirectUri = chatGptRedirectUri;

export type OAuthAuthorizationRequest = {
  clientId: typeof journalOAuthClientId;
  redirectUri: typeof chatGptOAuthRedirectUri;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state?: string;
};

export function oauthIssuer() {
  try {
    return oauthAuthorizationServerIssuer();
  } catch {
    return null;
  }
}

export function oauthResource(issuer = oauthIssuer()) {
  if (!issuer) return null;
  try {
    return getOAuthResource() === `${issuer}/mcp` ? getOAuthResource() : null;
  } catch {
    return null;
  }
}

export function oauthAuthorizationVersion() {
  const password = process.env.JOURNAL_WEB_PASSWORD;
  const clientSecret = process.env.JOURNAL_OAUTH_CLIENT_SECRET;
  if (!hasValidWebPassword(password) || !clientSecret || !/^[!-~]{32,}$/.test(clientSecret)) return null;
  return authorizationVersion(`${password}\0${clientSecret}`);
}

export function isOAuthConfigurationReady() {
  return oauthIssuer() !== null && oauthResource() !== null && oauthAuthorizationVersion() !== null;
}

export function oauthAuthorizationMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ['journal', 'offline_access'],
  };
}

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['journal'],
  };
}

export function requestUsesOAuthIssuer(host: string | null, forwardedProtocol: string | null) {
  const issuer = oauthIssuer();
  if (!issuer || !host) return false;
  const protocol = forwardedProtocol?.split(',')[0].trim() || 'https';
  return host.toLowerCase() === new URL(issuer).host.toLowerCase() && protocol === 'https';
}

function oneParameter(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

export function parseOAuthAuthorizationRequest(params: URLSearchParams):
  | { ok: true; request: OAuthAuthorizationRequest }
  | { ok: false; error: 'invalid_request' | 'invalid_client' | 'invalid_scope' | 'invalid_target' } {
  const clientId = oneParameter(params, 'client_id');
  const redirectUri = oneParameter(params, 'redirect_uri');
  if (clientId !== journalOAuthClientId) return { ok: false, error: 'invalid_client' };
  if (redirectUri !== chatGptOAuthRedirectUri) return { ok: false, error: 'invalid_request' };

  const responseType = oneParameter(params, 'response_type');
  const challenge = oneParameter(params, 'code_challenge');
  const challengeMethod = oneParameter(params, 'code_challenge_method');
  const resource = oneParameter(params, 'resource');
  const rawState = params.getAll('state');
  const rawScope = params.getAll('scope');
  const issuer = oauthIssuer();
  const expectedResource = oauthResource(issuer);
  if (!expectedResource || !isOAuthConfigurationReady()) return { ok: false, error: 'invalid_request' };
  if (resource !== expectedResource) return { ok: false, error: 'invalid_target' };
  if (
    responseType !== 'code' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    challengeMethod !== 'S256' || rawState.length > 1 || rawScope.length > 1
  ) return { ok: false, error: 'invalid_request' };

  const state = rawState[0];
  if (state !== undefined && (state.length > 512 || /[\u0000-\u001f\u007f]/.test(state))) {
    return { ok: false, error: 'invalid_request' };
  }
  const scopes = rawScope[0]?.trim().split(/\s+/).filter(Boolean) ?? ['journal'];
  if (!scopes.includes('journal') || scopes.some((scope) => !['journal', 'offline_access'].includes(scope))) {
    return { ok: false, error: 'invalid_scope' };
  }

  return {
    ok: true,
    request: {
      clientId: journalOAuthClientId,
      redirectUri: chatGptOAuthRedirectUri,
      scope: [...new Set(scopes)].sort().join(' '),
      resource,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      ...(state !== undefined ? { state } : {}),
    },
  };
}

export function oauthCallbackUrl(request: OAuthAuthorizationRequest, values: Record<string, string>) {
  const callback = new URL(request.redirectUri);
  for (const [name, value] of Object.entries(values)) callback.searchParams.set(name, value);
  if (request.state !== undefined) callback.searchParams.set('state', request.state);
  const issuer = oauthIssuer();
  if (!issuer) throw new Error('OAuth issuer is not configured.');
  callback.searchParams.set('iss', issuer);
  return callback.toString();
}

export function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
}
