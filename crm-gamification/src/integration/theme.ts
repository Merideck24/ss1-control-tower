/**
 * Tema del operador (A5) desde `GET /admin/theme-config` del admin. Funciones puras: se usan
 * en el servidor (endpoint) y en el navegador (sesión embebida con `theme`).
 */
export const DEFAULT_BRAND = '#d5a021';
export const PANEL = '#111111';
export const LOGO_HOSTS = ['syssoft1.sfo3.digitaloceanspaces.com', 'api.syssoft1.com', 'admin.syssoft1.com'];

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function normalizeHex(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  const m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  const m6 = /^#?([0-9a-f]{6})$/.exec(s);
  if (m6) return `#${m6[1]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(s);
  if (rgb && rgb.slice(1, 4).every((n) => Number(n) <= 255)) return '#' + rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return null;
}

/** Extrae color principal y logo de respuestas con formas comunes (Vuexy/Laravel). */
export function parseThemeConfig(body: unknown): { primary?: string; logo?: string } {
  const root = (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body) as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return {};
  const get = (path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), root);
  const primaryRaw = ['primary_color', 'primaryColor', 'primary', 'colors.primary', 'theme.primary', 'theme.colors.primary', 'dark_primary_color', 'darkThemePrimaryColor'].map(get).find((v) => normalizeHex(v));
  const logoRaw = ['logo_url', 'logo', 'logoUrl', 'theme.logo', 'assets.logo'].map(get).find((v) => typeof v === 'string');
  const out: { primary?: string; logo?: string } = {};
  const primary = normalizeHex(primaryRaw);
  if (primary) out.primary = primary;
  if (typeof logoRaw === 'string') {
    try { const u = new URL(logoRaw); if (u.protocol === 'https:' && LOGO_HOSTS.includes(u.hostname)) out.logo = u.toString(); } catch { /* ignorado */ }
  }
  return out;
}

export type BrandTokens = { brand: string; brandInk: string; brandSoft: string; brandGrad: string; source: 'tenant' | 'default'; note?: string };

/** Deriva los tokens de marca; si el color no tiene 3:1 sobre el panel oscuro, se mantiene el de SS1. */
export function deriveBrandTokens(primary?: string | null): BrandTokens {
  const p = normalizeHex(primary);
  const ok = p && contrast(p, PANEL) >= 3;
  const brand = ok ? p! : DEFAULT_BRAND;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(brand.slice(i, i + 2), 16));
  const brandInk = contrast(brand, '#000000') >= contrast(brand, '#ffffff') ? '#000000' : '#ffffff';
  return {
    brand, brandInk, brandSoft: `rgba(${r}, ${g}, ${b}, .16)`, brandGrad: `linear-gradient(72.47deg, ${brand} 22.16%, rgba(${r}, ${g}, ${b}, .72) 76.47%)`,
    source: ok ? 'tenant' : 'default', ...(p && !ok ? { note: `El color ${p} tiene poco contraste sobre fondo oscuro; se usa el dorado de SS1.` } : {}),
  };
}
