const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function mealField(value = "不需餐盒") {
  return `<label>餐盒需求<select name="meal_preference">${["不需餐盒", "葷食", "素食"].map((v) => `<option${v === value ? " selected" : ""}>${v}</option>`).join("")}</select></label><small>是否供餐請以活動公告為準。</small>`;
}
export function editRegistrationFields(r: any) {
  return `<label>姓名<input name="name" required maxlength="100" autocomplete="name" value="${esc(r.applicant_name)}"></label><label>服務單位<input name="organization" required maxlength="200" autocomplete="organization" value="${esc(r.organization)}"></label><label>聯絡信箱<input name="contact_email" type="email" required maxlength="254" autocomplete="email" value="${esc(r.contact_email)}"></label>${mealField(r.meal_preference)}`;
}
