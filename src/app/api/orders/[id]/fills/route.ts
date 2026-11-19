import { type OrderRoute, writeResponse } from '@/lib/http';

export const runtime = 'nodejs';

export function POST(request: Request, context: OrderRoute) {
  return writeResponse(request, 'fill', context);
}
