export const eventTypeLabels: Record<string, string> = {
  SUBMITTED: "挂单",
  FILLED: "成交",
  CANCELLED: "撤单",
};

export const orderStatusLabels: Record<string, string> = {
  OPEN: "未完成",
  PARTIALLY_FILLED: "部分成交",
  FILLED: "已成交",
  CANCELLED: "已撤单",
  UNKNOWN: "状态未知",
};

export const sideLabels: Record<string, string> = {
  BUY: "买入",
  SELL: "卖出",
};

export function formatDecimal(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value);
  const [integer, fraction] = raw.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedFraction = fraction?.replace(/0+$/, "");
  return trimmedFraction ? `${grouped}.${trimmedFraction}` : grouped;
}

export function formatPrice(value: string | number | null | undefined) {
  const decimal = formatDecimal(value);
  return decimal === "—" ? decimal : `$${decimal}`;
}

export function formatDateTime(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return "未记录";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function statusTone(status: string) {
  if (status === "FILLED") return "success";
  if (status === "CANCELLED" || status === "UNKNOWN") return "muted";
  if (status === "PARTIALLY_FILLED") return "info";
  return "warning";
}

export function eventTone(type: string) {
  if (type === "FILLED") return "success";
  if (type === "CANCELLED") return "danger";
  return "info";
}
