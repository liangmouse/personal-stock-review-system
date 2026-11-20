import { NextResponse, type NextRequest } from 'next/server';

export function proxy(_request: NextRequest) {
  const response = NextResponse.next();
  if (_request.nextUrl.pathname === '/oauth/authorize') {
    response.headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com/connector_platform_oauth_redirect; object-src 'none'");
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

export const config = { matcher: ['/oauth/authorize'] };
