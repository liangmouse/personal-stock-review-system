"use client";

import { useActionState, useState } from "react";

import { saveReview, type ReviewActionState } from "./actions";

type ReviewData = {
  id: string;
  pre_trade_plan: string | null;
  followed_plan: boolean | null;
  execution_review: string | null;
  deviations: string | null;
  lessons: string | null;
  version: number;
};

type ReviewValues = {
  pre_trade_plan: string;
  followed_plan: string;
  execution_review: string;
  deviations: string;
  lessons: string;
};

export function ReviewEditor({
  orderId,
  review,
  idempotencyKey,
  savedReviewId,
}: {
  orderId: string;
  review: ReviewData | null;
  idempotencyKey: string;
  savedReviewId: string | null;
}) {
  const initialState: ReviewActionState = {
    error: null,
    idempotencyKey,
    expectedVersion: null,
    conflict: false,
  };
  const [state, formAction, pending] = useActionState(saveReview, initialState);
  const [values, setValues] = useState<ReviewValues>({
    pre_trade_plan: review?.pre_trade_plan ?? "",
    followed_plan:
      review?.followed_plan === null || review?.followed_plan === undefined
        ? ""
        : String(review.followed_plan),
    execution_review: review?.execution_review ?? "",
    deviations: review?.deviations ?? "",
    lessons: review?.lessons ?? "",
  });
  const version = state.expectedVersion ?? review?.version ?? 0;
  const key = state.idempotencyKey || idempotencyKey;

  return (
    <form action={formAction} className="panel review-form">
      <input name="order_id" type="hidden" value={orderId} />
      <input name="expected_version" type="hidden" value={version} />
      <input name="idempotency_key" type="hidden" value={key} />

      {state.error && (
        <div aria-live="polite" className="form-alert form-alert-error" role="alert">
          <span aria-hidden="true">!</span>
          <p>{state.error}</p>
        </div>
      )}
      {state.conflict && (
        <label className="overwrite-confirm">
          <input name="overwrite_latest" required type="checkbox" value="confirm" />
          <span>我已检查当前表单，并确认用它覆盖较新的复盘版本。</span>
        </label>
      )}
      {savedReviewId && review?.id === savedReviewId && (
        <div aria-live="polite" className="form-alert form-alert-success" role="status">
          <span aria-hidden="true">✓</span>
          <p>
            复盘已保存。订单 ID <code>{orderId}</code> · 复盘 ID <code>{savedReviewId}</code>
          </p>
        </div>
      )}

      <div className="review-field">
        <label htmlFor="pre_trade_plan">下单前计划</label>
        <p className="field-hint">记录当时设定的委托条件与执行计划。</p>
        <textarea
          id="pre_trade_plan"
          maxLength={10_000}
          name="pre_trade_plan"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              pre_trade_plan: event.currentTarget.value,
            }))
          }
          rows={4}
          value={values.pre_trade_plan}
        />
      </div>

      <div className="review-field">
        <label htmlFor="followed_plan">是否按计划执行</label>
        <p className="field-hint">只记录执行情况，不填写行情判断。</p>
        <select
          id="followed_plan"
          name="followed_plan"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              followed_plan: event.currentTarget.value,
            }))
          }
          value={values.followed_plan}
        >
          <option value="">尚未记录</option>
          <option value="true">是，按计划执行</option>
          <option value="false">否，未按计划执行</option>
        </select>
      </div>

      <div className="review-field">
        <label htmlFor="execution_review">挂单、成交与撤单过程</label>
        <p className="field-hint">说明订单过程是否符合预期。</p>
        <textarea
          id="execution_review"
          maxLength={10_000}
          name="execution_review"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              execution_review: event.currentTarget.value,
            }))
          }
          rows={5}
          value={values.execution_review}
        />
      </div>

      <div className="review-field">
        <label htmlFor="deviations">执行偏差及原因</label>
        <textarea
          id="deviations"
          maxLength={10_000}
          name="deviations"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              deviations: event.currentTarget.value,
            }))
          }
          rows={4}
          value={values.deviations}
        />
      </div>

      <div className="review-field">
        <label htmlFor="lessons">纪律复盘与下一次改进</label>
        <textarea
          id="lessons"
          maxLength={10_000}
          name="lessons"
          onChange={(event) =>
            setValues((current) => ({
              ...current,
              lessons: event.currentTarget.value,
            }))
          }
          rows={4}
          value={values.lessons}
        />
      </div>

      <div className="review-form-footer">
        <span>
          {state.conflict
            ? `最新版本 ${version}`
            : review
              ? `复盘版本 ${review.version}`
              : "尚无复盘记录"}
        </span>
        <button className="button button-primary" disabled={pending} type="submit">
          {pending
            ? "正在保存…"
            : state.conflict
              ? "确认并再次保存"
              : review
                ? "保存修改"
                : "保存复盘"}
        </button>
      </div>
    </form>
  );
}
