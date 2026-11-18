export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string;
  updated_at: string;
  status: string;
  sequence?: number;
};
const escape = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
const stamp = (s: string) =>
  new Date(s)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
// RFC 5545 line folding: at most 75 UTF-8 octets, never split a code point.
function fold(line: string) {
  let out = "",
    length = 0;
  for (const c of line) {
    const n = Buffer.byteLength(c);
    if (length + n > 75) {
      out += "\r\n ";
      length = 1;
    }
    out += c;
    length += n;
  }
  return out;
}
export function eventCalendar(e: CalendarEvent) {
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//NTUCC//Meetup Events//ZH-TW",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `SEQUENCE:${e.sequence ?? 0}`,
      `UID:${e.id}@ntucc-meetup`,
      `DTSTAMP:${stamp(e.updated_at)}`,
      `LAST-MODIFIED:${stamp(e.updated_at)}`,
      `DTSTART:${stamp(e.starts_at)}`,
      `DTEND:${stamp(e.ends_at)}`,
      `SUMMARY:${escape(e.title)}`,
      `DESCRIPTION:${escape(e.description)}`,
      `LOCATION:${escape(e.location)}`,
      `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}
