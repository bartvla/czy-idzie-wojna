/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL Cloudflare Workera z danymi na żywo, bez końcowego ukośnika; pusty = tylko snapshot */
  readonly VITE_LIVE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
