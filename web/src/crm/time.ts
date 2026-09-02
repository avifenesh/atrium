export function relDay(iso: string | null): string {
  if (!iso) return '';
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  if (Number.isNaN(days)) return iso;
  if (days === 0) return 'today';
  if (days < 0) return `${-days}d overdue`;
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

export function age(iso: string | null): string {
  if (!iso) return '';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (Number.isNaN(hours) || hours < 0) return '';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
