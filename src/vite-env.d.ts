/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL Cloudflare Workera z danymi na żywo, bez końcowego ukośnika; pusty = tylko snapshot */
  readonly VITE_LIVE_API_URL?: string
  /** Darmowy klucz CARTO Basemaps (carto.com/basemaps/apikey); pusty = podkład Esri bez klucza */
  readonly VITE_CARTO_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
