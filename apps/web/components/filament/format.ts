const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })

/** "240–260 °C", "≤ 60 °C", or null when neither bound is known. */
export function formatRange(min: number | null, max: number | null, unit: string): string | null {
  if (min == null && max == null) return null
  if (min != null && max != null)
    return min === max
      ? `${NUMBER.format(min)} ${unit}`
      : `${NUMBER.format(min)}–${NUMBER.format(max)} ${unit}`
  return min != null ? `≥ ${NUMBER.format(min)} ${unit}` : `≤ ${NUMBER.format(max!)} ${unit}`
}

export function formatValue(value: number | null, unit: string): string | null {
  return value == null ? null : `${NUMBER.format(value)} ${unit}`
}

/** "1 kg", "750 g". */
export function formatWeight(grams: number | null): string | null {
  if (grams == null) return null
  return grams >= 1000 && grams % 100 === 0
    ? `${NUMBER.format(grams / 1000)} kg`
    : `${NUMBER.format(grams)} g`
}

/** `high_flow` → "High flow". */
export function humanise(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
