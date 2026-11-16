import { decodeHTML } from "entities";
export const rules = [
  ["身分證字號", /[A-Z][12]\d{8}/gi],
  ["病歷號", /(?:病歷號|MRN|Chart\s*No\.?|病患編號)[:：\s#-]*\d{6,10}/gi],
  ["姓名", /(?:病患|病人|個案|患者)[\u4e00-\u9fa5]{2,4}/g],
  ["床號", /\b\d{1,2}[A-Z]-\d{1,2}\b|ICU-\d{2}/gi],
  ["手機號碼", /09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g],
] as const;
export function detectPII(text: string) {
  text = decodeHTML(text);
  return rules.flatMap(([type, re]) =>
    Array.from(text.matchAll(new RegExp(re.source, re.flags)), (m) => ({
      type,
      text: m[0],
      index: m.index!,
    })),
  );
}
export function maskPII(text: string) {
  if (detectPII(text).length) text = decodeHTML(text);
  for (const [type, re] of rules)
    text = text.replace(new RegExp(re.source, re.flags), `[${type}已遮罩]`);
  return text;
}
export function scanValue(value: unknown): ReturnType<typeof detectPII> {
  if (typeof value === "string") return detectPII(value);
  if (Array.isArray(value)) return value.flatMap(scanValue);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(scanValue);
  return [];
}
export function maskValue(value: any): any {
  if (typeof value === "string") return maskPII(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskValue(v)]),
    );
  return value;
}
