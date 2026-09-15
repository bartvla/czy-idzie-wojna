# vercel-live

Funkcja pośrednicząca dla lotnictwa na żywo: adsb.fi i adsb.lol odrzucają zapytania z Cloudflare Workers, więc Worker pyta tę funkcję na Vercelu.

```bash
cd vercel-live
npm run bundle   # pakuje src/mil.ts + ../shared/aircraft.ts do api/mil.js
npm run deploy   # bundle + vercel deploy --prod
```

Wymaga zmiennej środowiskowej `LIVE_KEY` w projekcie Vercel, identycznej jak sekret `LIVE_SOURCE_KEY` w Workerze.
