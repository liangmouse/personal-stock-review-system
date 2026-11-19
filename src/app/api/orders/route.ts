import { ordersResponse, writeResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ordersResponse;
export function POST(request: Request) {
  return writeResponse(request, 'create');
}
