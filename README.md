# czyidziewojna.pl

Jednostronicowy dashboard z twardymi wskaźnikami napięcia geopolitycznego wokół Polski:
rynki, obligacje, waluty, rynki predykcyjne, ostrzeżenia dyplomatyczne, komunikaty.

## Stack

- React 19 + TypeScript + Vite, wykresy: Recharts
- Bez klasycznego backendu. Skrypt `scripts/fetch-data.ts` (Node 22+, `tsx`) pobiera dane i zapisuje
  `public/data/snapshot.json`. GitHub Actions (`.github/workflows/deploy.yml`) uruchamia go co godzinę,
  buduje stronę i publikuje na GitHub Pages. Jedyny element serwerowy to mały Cloudflare Worker
  (proxy dla mapy lotnictwa na żywo).
- `public/data/history.json` to własna, narastająca historia dla wskaźników, które nie mają
  darmowej dziennej historii (rentowności obligacji z TradingView).

## Uruchomienie

```bash
npm install
npm run fetch   # pobiera dane -> public/data/snapshot.json
npm run dev     # http://localhost:5173
npm run build   # produkcja -> dist/
```

## Źródła danych (stan na wrzesień 2026)

| Wskaźnik | Źródło | Format | Uwagi |
| --- | --- | --- | --- |
| WIG20 (dzienne zamknięcia) | [BiznesRadar](https://www.biznesradar.pl/notowania-historyczne/WIG20) | HTML, 50 sesji/stronę | Stooq ma blokadę anty-botową (proof-of-work w JS), Yahoo `WIG20.WA` nie ma historii, Bankier tylko miesięczne. |
| USD/PLN, EUR/PLN | [API NBP](https://api.nbp.pl/) | JSON, kurs średni tabeli A | Oficjalne, stabilne, max 255 ostatnich notowań na zapytanie. Brak CORS, stąd pobieranie po stronie skryptu. |
| Rentowność obligacji 10Y PL | [TradingView scanner](https://scanner.tradingview.com/global/scan) (bieżąca) + [FRED `IRLTLT01PLM156N`](https://fred.stlouisfed.org/series/IRLTLT01PLM156N) (historia miesięczna OECD) | JSON / CSV | Brak darmowego, dziennego źródła historii dla PL10Y. Budujemy własną historię ze zrzutów. Alternatywa do sprawdzenia: fixing Treasury BondSpot Poland. |
| Prawdopodobieństwa zdarzeń | [Polymarket Gamma API](https://gamma-api.polymarket.com/events?slug=nato-article-5-before-2027) | JSON | Rynki: inwazja Rosji na kraj NATO, starcie NATO–Rosja, art. 5, inwazja Rosji na kolejny kraj. Rynek „Russian strike on Poland” jest zamknięty; nowe rynki trzeba dopisać w `POLYMARKET_EVENTS`. |
| Ostrzeżenia dla podróżnych do Polski | [US State Dept RSS](https://travel.state.gov/_res/rss/TAsTWs.xml), [UK FCDO content API](https://www.gov.uk/api/content/foreign-travel-advice/poland) | XML / JSON | Podniesienie poziomu (Level 3/4, „avoid all travel”) to typowy sygnał przed ewakuacją ambasad. Do dodania: Kanada, Niemcy (AA), Francja. |
| Komunikaty MON / RCB / MSZ | gov.pl, sekcja „Aktualności” na stronie głównej instytucji | HTML | gov.pl nie ma RSS; podstrony list przekierowują boty na stronę główną portalu, ale strona główna instytucji działa. wojsko-polskie.pl (DORSZ) blokuje boty (Imperva). |
| Alarmy lotnicze w Ukrainie | [ubilling.net.ua/aerialalerts](https://ubilling.net.ua/aerialalerts/?json=true) (główne), [alerts.com.ua](https://alerts.com.ua/api/states) (zapasowe) | JSON, bez klucza | Stan alarmu per obwód. Pokazujemy 8 zachodnich obwodów. Uwaga: 13.09.2026 oba źródła się różniły (ubilling 10/26 alarmów, alerts.com.ua 1/25), więc do produkcji warto wziąć darmowy token z [alerts.in.ua](https://alerts.in.ua/) (mail do api@alerts.in.ua) albo ukrainealarm.com i podpiąć jako źródło główne. |
| Lotnictwo wojskowe nad Polską | [adsb.fi /v2/mil](https://opendata.adsb.fi/api/v2/mil) (główne), [adsb.lol /v2/mil](https://api.adsb.lol/v2/mil) (zapasowe) | JSON, bez klucza, rozsądny User-Agent | Oba API są zgodne z readsb (ten sam JSON). adsb.lol z adresów Cloudflare odpowiada 429, adsb.fi nie. Tylko maszyny nadające ADS-B i oflagowane jako wojskowe. Kategoryzacja po kodzie typu ICAO i prefiksie znaku wywoławczego (`shared/aircraft.ts`). OpenSky działa anonimowo jako alternatywa, ale bez flagi „wojskowy”. airplanes.live wymaga zgody mailowej, adsb.one blokuje boty. |
| Zakłócenia GPS (Bałtyk, Polska) | [gpsjam.org](https://gpsjam.org/) dzienny CSV `/data/YYYY-MM-DD-h3_4.csv` | CSV, siatka H3 res 4 | Plik za poprzedni dzień. Liczymy odsetek komórek z ≥10% samolotów zgłaszających złą nawigację w bboxie Bałtyku i Polski (h3-js). Historia narasta w `history.json`. |

### Źródła sprawdzone i odrzucone

- **Stooq** – CSV zablokowane przez weryfikację proof-of-work w przeglądarce.
- **Yahoo `WIG20.WA`** – tylko bieżąca wartość, brak historii; `ETFBW20TR.WA` (Beta ETF WIG20TR) ma historię i może być proxy.
- **Bankier `new-charts/get-data`** – dane miesięczne i nieaktualne.
- **Investing.com API** – 403.
- **gpw.pl / gpwbenchmark.pl** – połączenie zrywane dla klientów nieprzeglądarkowych.
- **alerts.in.ua** (alarmy lotnicze w Ukrainie) – wymaga darmowego tokenu (mail do api@alerts.in.ua).

## Układ strony

Kolejność według bezpośredniości i szybkości reakcji sygnału, nie według „ważności rynków”:

1. **Werdykt** – indeks napięcia z trendem 7-dniowym i cztery kluczowe liczby (ostatni Alert RCB, alarmy w zachodniej Ukrainie, maszyny wojskowe nad Polską, zakłócenia GPS).
2. **Trzy mapy (Leaflet + kafle CARTO dark)** – obwody Ukrainy ze stanem alarmu (`public/geo/ukr-adm1.json`, geoBoundaries/OSM, ODbL, uproszczone mapshaperem do 21 KB), komórki H3 z zakłóceniami GPS (obrysy liczone w skrypcie, tylko region mapy), pozycje samolotów wojskowych z kursem i popupem.
3. **Instytucje i dyplomacja** – komunikaty MON/RCB/MSZ, ostrzeżenia dla podróżnych.
4. **Rynki finansowe**, 5. **Rynki predykcyjne**.

Mapy alarmów i GPS pokazują stan z ostatniego runu skryptu (do godziny). Mapa lotnictwa ma podgląd na żywo przez Workera (poniżej).

## Podgląd na żywo: Cloudflare Worker (`worker/`)

API ADS-B wymagają nagłówka User-Agent, którego przeglądarka nie ustawi, i limitują częste zapytania (429). Worker jest cienkim proxy z cache:

- `GET /mil` zwraca `AirTraffic` (ten sam kształt co w snapshotcie); łańcuch źródeł adsb.fi → adsb.lol, filtrowanie i kategoryzacja z `shared/aircraft.ts`.
- Jedno zapytanie do upstreamu na 20 s niezależnie od liczby odwiedzających (Cache API, nagłówek `X-Cache: HIT/MISS`).
- Gdy wszystkie upstreamy odpowiedzą 429/5xx, serwowana jest ostatnia dobra odpowiedź do 10 min (`X-Cache: STALE`), a frontend przy błędzie wraca do snapshotu.
- Frontend odpytuje Workera co 30 s, tylko gdy karta przeglądarki jest widoczna. Adres podaje zmienna `VITE_LIVE_API_URL`; bez niej mapa pokazuje snapshot.

Lokalnie: `cd worker && npm install && npm run dev` (http://localhost:8787/mil).

## Indeks napięcia

`src/lib/tension.ts` liczy prostą, jawną sumę punktów (0–100) z progów na wskaźnikach.
To nie jest prognoza, tylko streszczenie „nerwowości” obserwowanych danych. Progi są celowo
konserwatywne i łatwe do zmiany. Skrypt zapisuje dzienną wartość indeksu do `history.json`, z czego frontend liczy trend.
