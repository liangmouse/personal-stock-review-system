import { z } from "zod";

const decimalPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
const timestampSchema = z
  .iso.datetime({ offset: true })
  .refine(
    (value) =>
      /T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "must be an ISO timestamp with seconds, a timezone, and at most millisecond precision",
  );

function normalizeDecimal(value: string): string {
  const [whole, fraction] = value.split(".");
  const normalizedFraction = fraction?.replace(/0+$/, "");
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

export const decimalInput = z
  .string()
  .regex(decimalPattern, "must be a decimal string with at most 12 integer and 8 fractional digits")
  .transform(normalizeDecimal);

export const positiveDecimalInput = decimalInput.refine(
  (value) => value !== "0",
  "must be greater than zero",
);

const nullableOccurredAt = timestampSchema
  .nullable()
  .optional()
  .transform((value) => (value ? new Date(value) : null));

const noteInput = z
  .string()
  .max(2_000)
  .refine((value) => value.isWellFormed() && !value.includes("\0"), "must be valid Unicode without NUL characters")
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const idempotencyKeyInput = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "must contain printable non-space ASCII characters");

const symbolInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/)
  .toUpperCase();

export const orderIdInput = z.string().uuid();

export const createOrderInput = z
  .object({
    symbol: symbolInput,
    side: z.enum(["BUY", "SELL"]),
    order_type: z.enum(["LIMIT", "MARKET"]).nullable().optional(),
    limit_price: positiveDecimalInput.nullable().optional(),
    quantity: positiveDecimalInput,
    occurred_at: nullableOccurredAt,
    note: noteInput,
    idempotency_key: idempotencyKeyInput,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.order_type === "LIMIT" && !value.limit_price) {
      context.addIssue({
        code: "custom",
        path: ["limit_price"],
        message: "is required for a LIMIT order",
      });
    }
    if (value.order_type === "MARKET" && value.limit_price != null) {
      context.addIssue({
        code: "custom",
        path: ["limit_price"],
        message: "must be omitted for a MARKET order",
      });
    }
    if (value.order_type == null && value.limit_price != null) {
      context.addIssue({
        code: "custom",
        path: ["order_type"],
        message: "must be specified when limit_price is provided",
      });
    }
  });

export const recordFillInput = z
  .object({
    price: positiveDecimalInput,
    quantity: positiveDecimalInput,
    occurred_at: nullableOccurredAt,
    note: noteInput,
    idempotency_key: idempotencyKeyInput,
  })
  .strict();

export const cancelOrderInput = z
  .object({
    cancelled_quantity: positiveDecimalInput.nullable().optional(),
    occurred_at: nullableOccurredAt,
    note: noteInput,
    idempotency_key: idempotencyKeyInput,
  })
  .strict();

const pageInput = z
  .string()
  .regex(/^[1-9]\d{0,5}$/)
  .transform(Number)
  .default(1);

const pageSizeInput = z
  .string()
  .regex(/^[1-9]\d{0,2}$/)
  .transform(Number)
  .refine((value) => value <= 100)
  .default(25);

export const listOrdersInput = z
  .object({
    symbol: symbolInput.optional(),
    status: z
      .enum([
        "OPEN",
        "PARTIALLY_FILLED",
        "FILLED",
        "CANCELLED",
        "UNKNOWN",
      ])
      .optional(),
    side: z.enum(["BUY", "SELL"]).optional(),
    from: timestampSchema.optional(),
    to: timestampSchema.optional(),
    page: pageInput,
    page_size: pageSizeInput,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from && value.to && Date.parse(value.from) >= Date.parse(value.to)) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "must be later than from",
      });
    }
  });

export type CreateOrderInput = z.infer<typeof createOrderInput>;
export type RecordFillInput = z.infer<typeof recordFillInput>;
export type CancelOrderInput = z.infer<typeof cancelOrderInput>;
export type ListOrdersInput = z.infer<typeof listOrdersInput>;
