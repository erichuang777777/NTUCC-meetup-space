export function registrationCsv(rows: Record<string, any>[]) {
  const cell = (value: unknown) => {
    let s = String(value ?? "");
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      [
        "報名識別碼",
        "姓名",
        "單位",
        "聯絡信箱",
        "餐盒需求",
        "報名方式",
        "報到時間",
      ],
      ...rows.map((r) => [
        r.id,
        r.applicant_name,
        r.organization,
        r.contact_email,
        r.meal_preference,
        r.user_id ? "登入報名" : "免登入報名",
        r.checked_in_at,
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") +
    "\r\n"
  );
}
