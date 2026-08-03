import type { CalendarEvent } from '../../shared/types';

/** True when a timed event is effectively all-day (midnight start, ≥20h span). */
export function isEffectivelyAllDay(ev: CalendarEvent): boolean {
  if (ev.allDay) return true;
  const start = new Date(ev.start);
  if (start.getHours() !== 0 || start.getMinutes() !== 0) return false;
  const end = new Date(ev.end);
  return end.getTime() - start.getTime() >= 20 * 3600_000;
}

export function eventTimeLabel(ev: CalendarEvent, range = false): string {
  if (isEffectivelyAllDay(ev)) return 'all day';
  const hhmm = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  if (range) return `${hhmm(ev.start)}–${hhmm(ev.end)}`;
  return hhmm(ev.start);
}
