import { sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { writeRateLimit } from '../db/schema';

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export async function countJournalAttempt(
  id: number,
  maximum: number,
  message: string,
) {
  const minute = sql`date_trunc('minute', statement_timestamp())`;
  const [accepted] = await getDb().insert(writeRateLimit)
    .values({ id, windowStart: minute, hits: 1 })
    .onConflictDoUpdate({
      target: writeRateLimit.id,
      set: {
        windowStart: sql`greatest(${writeRateLimit.windowStart}, ${minute})`,
        hits: sql`case when ${writeRateLimit.windowStart} < ${minute} then 1 else ${writeRateLimit.hits} + 1 end`,
      },
      setWhere: sql`${writeRateLimit.windowStart} < ${minute} or ${writeRateLimit.hits} < ${maximum}`,
    })
    .returning({ hits: writeRateLimit.hits });

  if (!accepted) throw new RateLimitError(message);
}
