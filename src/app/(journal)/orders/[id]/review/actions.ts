"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { getReview, writeReview } from "@/lib/journal";
import { JournalError } from "@/lib/orders";
import { RateLimitError } from "@/lib/rate-limit";
import {
  countReviewAttempt,
  isSameOriginAction,
  requireSession,
} from "@/lib/session";

export type ReviewActionState = {
  error: string | null;
  idempotencyKey: string;
  expectedVersion: number | null;
  conflict: boolean;
};

function stringValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function failure(
  error: string,
  idempotencyKey: string,
  expectedVersion: number | null,
  conflict = false,
): ReviewActionState {
  return { error, idempotencyKey, expectedVersion, conflict };
}

export async function saveReview(
  previousState: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  await requireSession();

  const idempotencyKey = stringValue(formData, "idempotency_key");
  const orderId = stringValue(formData, "order_id");
  const expectedVersionValue = stringValue(formData, "expected_version");
  const followedPlanValue = stringValue(formData, "followed_plan");

  if (!await isSameOriginAction()) {
    return failure(
      "无法验证请求来源，请刷新页面后重试。",
      idempotencyKey ?? "",
      previousState.expectedVersion,
      previousState.conflict,
    );
  }
  if (!idempotencyKey || !orderId || expectedVersionValue === null) {
    return failure(
      "表单缺少订单、版本或幂等信息。请重新加载页面后重试。",
      idempotencyKey ?? "",
      previousState.expectedVersion,
      previousState.conflict,
    );
  }
  if (!/^(0|[1-9]\d{0,9})$/.test(expectedVersionValue)) {
    return failure(
      "复盘版本无效。请重新加载页面后重试。",
      idempotencyKey,
      previousState.expectedVersion,
      previousState.conflict,
    );
  }
  if (
    followedPlanValue === null ||
    (followedPlanValue !== "" &&
      followedPlanValue !== "true" &&
      followedPlanValue !== "false")
  ) {
    return failure(
      "是否按计划执行的选项无效。请重新选择后保存。",
      idempotencyKey,
      Number(expectedVersionValue),
      previousState.conflict,
    );
  }
  if (
    previousState.conflict &&
    stringValue(formData, "overwrite_latest") !== "confirm"
  ) {
    return failure(
      "请确认是否用当前表单内容覆盖另一处已保存的复盘。",
      idempotencyKey,
      previousState.expectedVersion,
      true,
    );
  }

  try {
    await countReviewAttempt();
  } catch (error) {
    if (error instanceof RateLimitError) {
      return failure(
        error.message,
        idempotencyKey,
        Number(expectedVersionValue),
        previousState.conflict,
      );
    }
    return failure(
      "暂时无法保存复盘。请保留当前内容，稍后使用原表单重试。",
      idempotencyKey,
      Number(expectedVersionValue),
      previousState.conflict,
    );
  }

  let receipt;
  try {
    receipt = await writeReview(getDb(), {
      order_id: orderId,
      idempotency_key: idempotencyKey,
      expected_version: Number(expectedVersionValue),
      pre_trade_plan: stringValue(formData, "pre_trade_plan"),
      followed_plan:
        followedPlanValue === "true"
          ? true
          : followedPlanValue === "false"
            ? false
            : null,
      execution_review: stringValue(formData, "execution_review"),
      deviations: stringValue(formData, "deviations"),
      lessons: stringValue(formData, "lessons"),
    });
  } catch (error) {
    if (error instanceof JournalError && error.status === 400) {
      return failure(
        error.message,
        idempotencyKey,
        Number(expectedVersionValue),
        previousState.conflict,
      );
    }
    if (error instanceof JournalError && error.status === 409) {
      let latestVersion = Number(expectedVersionValue);
      try {
        const current = await getReview(getDb(), orderId);
        latestVersion = current.review?.version ?? 0;
      } catch {
        // Keep the attempted version if a fresh version cannot be read.
      }
      return failure(
        "复盘已在另一处更新。当前表单内容仍保留。勾选下方确认框后再次保存，会覆盖较新的版本。",
        randomUUID(),
        latestVersion,
        true,
      );
    }
    if (error instanceof JournalError && error.status === 429) {
      return failure(
        "保存次数较多，请稍后再试。",
        idempotencyKey,
        Number(expectedVersionValue),
        previousState.conflict,
      );
    }
    return failure(
      "暂时无法保存复盘。请保留当前内容，稍后使用原表单重试。",
      idempotencyKey,
      Number(expectedVersionValue),
      previousState.conflict,
    );
  }

  revalidatePath("/");
  revalidatePath("/reviews");
  revalidatePath("/orders/" + receipt.order_id);
  revalidatePath("/orders/" + receipt.order_id + "/review");
  redirect(
    "/orders/" +
      receipt.order_id +
      "/review?saved_review=" +
      encodeURIComponent(receipt.review_id),
  );
}
