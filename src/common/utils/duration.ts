const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses "15m", "30d", "12h", "45s" into milliseconds. */
export function durationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function addDays(date: Date, days: number): Date {
  return addMs(date, days * UNIT_MS.d);
}

/** UTC calendar day (time stripped) — used for @db.Date columns. */
export function utcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
