/**
 * Puente del lado del admin para el CRM embebido (protocolo postMessage v1).
 * Sin dependencias de framework: lo usa el componente Vue y se puede probar con un window falso.
 */
export type CaslRule = { action: string | string[]; subject: string | string[]; inverted?: boolean };
export type CrmSession = {
  accessToken: string;
  tenantId: string;
  user: { id: string; name?: string };
  abilities: CaslRule[];
  locale?: 'es' | 'en' | 'pt';
  theme?: { primary?: string; logo?: string };
};
export type BridgeOptions = {
  crmOrigin: string;
  /** Ventana del iframe del CRM (iframe.contentWindow). */
  target: () => { postMessage(msg: unknown, origin: string): void } | null | undefined;
  /** Se llama en cada `ready`: siempre con el token vigente. */
  getSession: () => CrmSession | null;
  onTitle?: (title: string, tab: string) => void;
  onResize?: (height: number) => void;
  /** Pestaña inicial (enlace directo), p. ej. desde la ruta /crm-gamification/:tab */
  initialTab?: string;
};
type Listener = (e: { origin: string; source?: unknown; data: unknown }) => void;
export type EventHost = { addEventListener(t: 'message', l: Listener): void; removeEventListener(t: 'message', l: Listener): void };

const TABS = new Set(['tower', 'profile', 'segments', 'builder', 'approval', 'analytics', 'loyalty', 'copilot', 'audit']);

export function createCrmBridge(host: EventHost, o: BridgeOptions) {
  const post = (msg: Record<string, unknown>) => o.target()?.postMessage({ ...msg, version: 1 }, o.crmOrigin);
  let pendingTab = o.initialTab && TABS.has(o.initialTab) ? o.initialTab : undefined;
  const onMessage: Listener = (e) => {
    if (e.origin !== o.crmOrigin) return; // solo el CRM configurado
    if (e.source !== undefined && e.source !== o.target()) return;
    const d = e.data as { type?: string; title?: unknown; tab?: unknown; height?: unknown } | null;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'ss1-crm:ready') {
      const s = o.getSession();
      if (!s) return; // sin sesión no se envía nada; el CRM mostrará su aviso
      post({ type: 'ss1-crm:session', ...s });
      if (pendingTab) { post({ type: 'ss1-crm:navigate', tab: pendingTab }); pendingTab = undefined; }
    } else if (d.type === 'ss1-crm:title' && typeof d.title === 'string') {
      o.onTitle?.(d.title.slice(0, 80), typeof d.tab === 'string' ? d.tab : '');
    } else if (d.type === 'ss1-crm:resize' && typeof d.height === 'number' && Number.isFinite(d.height)) {
      o.onResize?.(Math.max(300, Math.min(Math.ceil(d.height), 50_000)));
    }
  };
  host.addEventListener('message', onMessage);
  return {
    navigate(tab: string) { if (TABS.has(tab)) post({ type: 'ss1-crm:navigate', tab }); },
    /** Reenvía la sesión (p. ej. tras refrescar el token). */
    refreshSession() { const s = o.getSession(); if (s) post({ type: 'ss1-crm:session', ...s }); },
    dispose() { host.removeEventListener('message', onMessage); },
  };
}
