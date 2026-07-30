/**
 * Minimal 5-field cron evaluation for the scheduler (spec §4.6 "Scheduler").
 *
 * Supports `*`, `n`, `a-b`, `a,b,c` and `* /n` step syntax across
 * minute hour day-of-month month day-of-week. That covers everything a
 * short-form tip asks for ("every morning at 7", "each Friday") without pulling
 * in a dependency; anything more exotic is rejected rather than guessed at.
 */

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function parseField(field: string, index: number): number[] | null {
  const [min, max] = RANGES[index]!;
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const token = part.trim();
    if (!token) return null;

    const stepMatch = token.match(/^(.+)\/(\d+)$/);
    const body = stepMatch?.[1] ?? token;
    const step = stepMatch?.[2] ? Number(stepMatch[2]) : 1;
    if (step < 1) return null;

    let start: number;
    let end: number;
    if (body === '*') {
      start = min;
      end = max;
    } else {
      const rangeMatch = body.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        start = Number(rangeMatch[1]);
        end = Number(rangeMatch[2]);
      } else if (/^\d+$/.test(body)) {
        start = Number(body);
        end = start;
      } else {
        return null;
      }
    }

    // Day-of-week 7 is a common alias for Sunday.
    if (index === 4) {
      if (start === 7) start = 0;
      if (end === 7) end = 0;
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values.size > 0 ? [...values].sort((a, b) => a - b) : null;
}

export function parseCron(expression: string): CronFields | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parsed = fields.map((field, index) => parseField(field, index));
  if (parsed.some((field) => field === null)) return null;

  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

/** True when `date` (UTC) matches the expression. */
export function cronMatches(fields: CronFields, date: Date): boolean {
  const dayOfMonthRestricted = fields.daysOfMonth.length !== 31;
  const dayOfWeekRestricted = fields.daysOfWeek.length !== 7;

  const dayOfMonthOk = fields.daysOfMonth.includes(date.getUTCDate());
  const dayOfWeekOk = fields.daysOfWeek.includes(date.getUTCDay());

  // Standard cron semantics: when both day fields are restricted, either matching
  // is enough; when only one is, that one must match.
  const dayOk =
    dayOfMonthRestricted && dayOfWeekRestricted
      ? dayOfMonthOk || dayOfWeekOk
      : dayOfMonthOk && dayOfWeekOk;

  return (
    fields.minutes.includes(date.getUTCMinutes()) &&
    fields.hours.includes(date.getUTCHours()) &&
    fields.months.includes(date.getUTCMonth() + 1) &&
    dayOk
  );
}

/**
 * Next UTC firing time strictly after `from`, or null if the expression is
 * invalid or cannot fire within a year (e.g. Feb 30).
 */
export function nextRunFor(expression: string, from: Date = new Date()): string | null {
  const fields = parseCron(expression);
  if (!fields) return null;

  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const LIMIT_MINUTES = 366 * 24 * 60;
  for (let step = 0; step < LIMIT_MINUTES; step++) {
    if (cronMatches(fields, cursor)) return cursor.toISOString();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Human-readable rendering for the UI, falling back to the raw expression. */
export function describeCron(expression: string): string {
  const fields = parseCron(expression);
  if (!fields) return expression;

  const time =
    fields.hours.length === 1 && fields.minutes.length === 1
      ? `${String(fields.hours[0]).padStart(2, '0')}:${String(fields.minutes[0]).padStart(2, '0')}`
      : null;

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const everyDay = fields.daysOfWeek.length === 7 && fields.daysOfMonth.length === 31;

  if (time && everyDay) return `every day at ${time} UTC`;
  if (time && fields.daysOfWeek.length === 1) return `every ${DAY_NAMES[fields.daysOfWeek[0]!]} at ${time} UTC`;
  if (time && fields.daysOfWeek.length === 5 && fields.daysOfWeek.every((d) => d >= 1 && d <= 5)) {
    return `every weekday at ${time} UTC`;
  }
  if (fields.hours.length === 24 && fields.minutes.length === 1) return `every hour at :${String(fields.minutes[0]).padStart(2, '0')}`;
  return expression;
}
