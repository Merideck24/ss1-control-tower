// Formatos en es-CO, iguales a los del CRM.
export const int = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('es-CO'))
export const money = (minor: number | null | undefined, currency = 'COP') =>
  minor === null || minor === undefined ? '—' : (minor / 100).toLocaleString('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 })
export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('es-CO') : '—')
export const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('es-CO')} ms`)
