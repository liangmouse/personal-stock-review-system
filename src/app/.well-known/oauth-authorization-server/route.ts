import { metadataResponse } from '@/lib/oauth-metadata';

export const dynamic = 'force-dynamic';

export function GET() {
  return metadataResponse('authorization-server');
}
