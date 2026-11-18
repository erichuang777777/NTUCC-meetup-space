export type RegistrationIdentity = {
  applicant_name?: string | null;
  display_name?: string | null;
  user_id: string;
};
/** Prefer the attendee's submitted name; account profile is legacy fallback only. */
export function registrationName(row: RegistrationIdentity): string {
  return row.applicant_name?.trim() || row.display_name?.trim() || row.user_id;
}
