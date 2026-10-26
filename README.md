# Design Review

Aplikacja webowa do **komentowania designu stron HTML**. Wgrywasz stronę jako archiwum ZIP
albo podajesz adres **opublikowanej strony (np. WordPress)**, wysyłasz recenzentowi link,
a on dodaje komentarze w dwóch trybach:

- **pinezka** – kliknięcie w konkretne miejsce na stronie,
- **zaznaczony tekst** – podświetlenie fragmentu tekstu i komentarz do niego.

Recenzenci **nie potrzebują konta ani logowania**. Przy pierwszym komentarzu
wystarczy podać imię (zapamiętywane w przeglądarce i podstawiane przy kolejnych
komentarzach). Loguje się tylko właściciel aplikacji — strony głównej z listą
wgranych stron pilnuje pojedyncze pole **uid**. Dodatkowo dowolną stronę można
zabezpieczyć **hasłem** — wtedy recenzent musi je wpisać przed wejściem,
a właściciel (zalogowany uid-em) wchodzi bez hasła.

## Szybki start

```bash
npm install
npm start
```

Aplikacja działa pod adresem <http://localhost:3000>.

Przy pierwszym starcie generowany jest **uid** — długi, losowy ciąg 64 znaków.
Zostaje on wypisany w konsoli i zapisany w `data/config.json`:

```
  Logowanie: http://localhost:3000/login
  Twój uid:  384f2dec8c4b3dc427e3205018b0151681fd3569d1d777c9503d0cefc8d2e409
```

Zachowaj go: to jedyne hasło do aplikacji. Można go też ustawić z góry:

```bash
set ADMIN_UID=moj-wlasny-dlugi-ciag && npm start
```

Do wypróbowania dołączony jest przykładowy projekt: **`sample/landing.zip`**.
Wystarczy wgrać go na stronie głównej.

Zmienna środowiskowa `PORT` pozwala zmienić port:

```bash
set PORT=8080 && npm start
```

Zmienna `PUBLIC_URL` to publiczny adres aplikacji (np. za odwrotnym proxy z HTTPS).
Trafia do skryptu, który wkleja się na stronach na żywo — bez niej używany jest adres,
pod którym otwarto panel (z protokołem z nagłówka `X-Forwarded-Proto`, jeśli proxy
go przekazuje):

```bash
set PUBLIC_URL=https://review.twojadomena.pl && npm start
```

Wymagany jest Node.js 20 lub nowszy.

## Powiadomienia mailowe

Gdy recenzent doda komentarz, administrator dostaje maila. Komentarze są
**zbierane per projekt**: mail wychodzi, gdy przez **4 minuty** nie pojawił się
nowy komentarz, ale nie później niż **15 minut** od pierwszego niewysłanego.
Kilkanaście uwag z jednej sesji recenzji to więc jeden mail, a nie kilkanaście.

- W mailu: nazwa projektu, a przy każdym komentarzu autor, podstrona, treść,
  zaznaczony fragment i link **„Pokaż komentarz”** (`/v/<id>?c=<komentarz>`) –
  otwiera właściwą podstronę i wyróżnia komentarz.
- Komentarze dodane przez właściciela (zalogowanego uid-em) nie wyzwalają maila.
- Maksymalnie 20 maili na godzinę (komentowanie jest publiczne – limit chroni
  skrzynkę). Nieudana wysyłka jest ponawiana po 5 minutach.
- Stan („do którego komentarza już powiadomiono”) jest zapisany przy projekcie,
  więc restart serwera nie gubi powiadomień ani ich nie dubluje. Komentarze
  sprzed włączenia powiadomień nie są wysyłane.

Konfiguracja (zmienne środowiskowe; bez `NOTIFY_EMAIL` powiadomienia są wyłączone):

| Zmienna | Znaczenie |
| --- | --- |
| `NOTIFY_EMAIL` | adres, na który przychodzą powiadomienia |
| `SMTP_USER` | konto nadawcy, np. `design-review@learnetic.com` |
| `SMTP_PASS` | hasło – dla Gmaila **hasło aplikacji** (16 znaków) |
| `SMTP_HOST` / `SMTP_PORT` | domyślnie `smtp.gmail.com` / `465` (587 = STARTTLS) |
| `MAIL_FROM` | nadawca, domyślnie `SMTP_USER` |
| `PUBLIC_URL` | adres aplikacji do linków w mailach (zalecane) |

Firmowy Gmail (Google Workspace):

1. Na koncie nadawcy włącz weryfikację dwuetapową.
2. Utwórz hasło aplikacji: <https://myaccount.google.com/apppasswords>
   (jeśli tej opcji nie ma, administrator Workspace musi dopuścić hasła
   aplikacji albo udostępnić przekaźnik SMTP `smtp-relay.gmail.com`).
3. Uruchom aplikację, np.:
   ```bash
   NOTIFY_EMAIL=ja@learnetic.com SMTP_USER=design-review@learnetic.com \
   SMTP_PASS='abcd efgh ijkl mnop' PUBLIC_URL=https://review.twojadomena.pl npm start
   ```
4. W panelu kliknij **✉️ Testowy mail** (przycisk widać tylko, gdy powiadomienia
   są skonfigurowane) – błąd logowania SMTP pojawi się w komunikacie.

Gmail wysyła maile jako `SMTP_USER`; inny `MAIL_FROM` zadziała tylko, jeśli to
alias dodany na tym koncie. Bez `PUBLIC_URL` linki w mailach używają adresu, pod
którym właściciel ostatnio otworzył aplikację (zapamiętanego w `data/notify.json`).

Tryb testowy: `MAIL_TRANSPORT=log` zapisuje maile do `data/outbox/` zamiast
je wysyłać. Czasy można skrócić zmiennymi `NOTIFY_QUIET_MS`, `NOTIFY_MAX_MS`
i `NOTIFY_TICK_MS` (zob. sekcja **Testy**).

## Logowanie i dostęp

- **Strona główna `/`** (lista stron, wgrywanie, usuwanie) wymaga zalogowania.
  Bez sesji każde jej żądanie kończy się przekierowaniem na `/login`.
- **Logowanie** to jedno pole: wklejasz swój uid. Nie ma nazwy użytkownika,
  haseł ani wielu kont. Po zalogowaniu przeglądarka dostaje ciasteczko
  `design_review_session` (httpOnly) z osobnym tokenem sesji — sam uid nie jest
  odsyłany w każdym żądaniu.
- **Recenzenci nie logują się.** Osoba, która dostanie link `/v/<id>`, widzi
  podgląd strony i panel komentarzy. W miejscu przycisku „Wszystkie strony”
  ma **„Zaloguj”** prowadzące do ekranu logowania — listy stron nie zobaczy.
  Ekran logowania otwarty w ten sposób ma u góry **„← Wróć do recenzji”**
  (powrót bez logowania); po zalogowaniu wracasz do tej samej recenzji.
  Przy wejściu prosto na stronę główną strzałka się nie pojawia.
- Zalogowany właściciel na stronie głównej ma w pasku przyciski
  **„🔑 Kopiuj uid”** (skopiowanie uid do schowka, np. żeby zalogować się na
  innym urządzeniu) oraz **„Wyloguj”**.
- **Hasło do pojedynczej strony.** Każdą wgraną stronę można zabezpieczyć
  hasłem (przycisk 🔓/🔒 przy projekcie na liście). Recenzent z linkiem trafia
  wtedy na ekran „Strona zabezpieczona” i musi wpisać hasło; po jego podaniu
  dostaje ciasteczko odblokowujące ważne 30 dni. Na tym ekranie jest też link
  **„zalogować się uid-em”** — właściciel może zamiast hasła zalogować się
  i wrócić prosto do recenzji (zalogowany właściciel **nigdy nie musi wpisywać
  hasła**). Zmiana hasła unieważnia wcześniejsze odblokowania. Hasło trzymane
  jest wyłącznie jako skrót (scrypt + losowa sól), nigdy jawnym tekstem.
- Publiczne pozostają: `/login`, `/unlock/<id>`, `/api/projects/:id/access`,
  `/api/projects/:id/unlock`, `/v/<id>`, `/p/<id>/...` oraz API komentarzy —
  bez tego recenzent nie mógłby niczego skomentować. Jeśli strona ma hasło,
  `/v/<id>`, `/p/<id>/...`, `/api/projects/:id` (z komentarzami), archiwum ZIP
  i API komentarzy wymagają wcześniejszego odblokowania hasłem.

## Jak to działa

### Strona główna `/` (wymaga zalogowania)

- w pasku: **🔑 Kopiuj uid** i **Wyloguj**,
- lista przesłanych stron (nazwa, data, rozmiar, liczba plików, wykryty plik startowy),
- przeciągnij i upuść plik `.zip` albo wybierz go z dysku (limit 50 MB),
- **Kopiuj link** – skopiowanie adresu do udostępnienia recenzentowi,
- akcje przy projekcie to ikony (oszczędzają miejsce): **👁** widok recenzji,
  **↗** sama strona w nowej karcie, **🔄** podmiana plików na nowszą wersję ZIP,
  **⬇** pobranie projektu jako ZIP, **🔒/🔓** hasło dostępu,
  **🗑** usunięcie strony wraz z komentarzami.
  Pełny opis każdej ikony pojawia się po najechaniu myszą. Usunięcie strony
  potwierdzasz oknem dialogowym w stylu aplikacji (nie natywnym oknem
  przeglądarki),
- sekcja **🌐 Recenzja strony na żywo (WordPress)** – dodanie strony po adresie
  (szczegóły niżej). Przy takich stronach zamiast 🔄 i ⬇ jest ikona
  **📋 Kopiuj skrypt** – kopiuje do schowka skrypt do wklejenia na stronie.

### Strony na żywo (WordPress)

Opublikowaną stronę można recenzować bezpośrednio, bez pobierania jej plików
i bez zrzutów ekranu:

1. W sekcji **🌐 Recenzja strony na żywo** podaj adres strony
   (np. `https://twoja-strona.pl/oferta/`; `https://` można pominąć).
2. Pojawi się okno z gotowym skryptem i przyciskiem **📋 Kopiuj skrypt**:
   ```html
   <script src="https://<adres-design-review>/annotator.js" defer></script>
   ```
   Wklej go **raz** na stronie – działa na wszystkich jej podstronach. Najprościej
   przez wtyczkę **WPCode** (Header & Footer → *Footer*) albo
   **Elementor → Custom Code** (koniec `<body>`). Skrypt jest ten sam dla
   wszystkich stron i projektów, więc później można go skopiować ikoną 📋.
3. Udostępnij link `/v/<id>` jak przy zwykłym projekcie.

Jak to działa:

- Widok recenzji ładuje stronę w ramce. Skrypt na stronie WordPress uruchamia
  się **tylko wtedy, gdy ramką jest widok Design Review** (rozpoznaje go po
  adresie, z którego sam został pobrany). Zwykli odwiedzający, a także obce
  strony osadzające witrynę w ramce, nie widzą żadnej zmiany i nic nie dostają.
- Skrypt do wklejenia **nie zawiera wersji w adresie** i jest wysyłany
  z `Cache-Control: no-cache`: przeglądarka przy każdym użyciu krótko sprawdza,
  czy plik się zmienił (niezmieniony kończy się odpowiedzią 304). Dzięki temu
  po aktualizacji aplikacji recenzenci od razu dostają nową warstwę adnotacji,
  a skryptu na stronie nie trzeba wklejać ponownie. Wersja (`/annotator.js?v=…`,
  cache'owana „na zawsze”) jest tylko na stronach z ZIP-a, gdzie serwer wstawia
  skrypt przy każdym wczytaniu strony.
- Komentarz zapamiętuje ścieżkę podstrony (np. `/oferta/`; przy odnośnikach
  `?p=123` / `?page_id=123` także ten parametr) oraz **ID wpisu WordPressa**
  (z klas `page-id-…` / `postid-…` na `<body>`) – dzięki temu zostaje na swojej
  podstronie także po zmianie jej adresu.
- Dozwolone są adres strony i jego wariant z `www.` albo bez niego
  (WordPress często między nimi przekierowuje).
- Klucz podstrony zawsze wskazuje recenzowaną witrynę — adresy, które po
  normalizacji próbują wskazać inny host (np. `//evil.com`), są odrzucane,
  więc komentarz nie wyprowadzi podglądu poza stronę.
- Treść strony na żywo się zmienia (slidery, doładowywane sekcje), więc warstwa
  adnotacji przelicza położenie pinezek także po zmianach w DOM-ie.

Nawigacja w podglądzie:

- **Link prowadzący poza recenzowaną stronę** (inna domena) nie przełącza
  podglądu – pojawia się komunikat z przyciskiem **„Otwórz w nowej karcie ↗”**.
  Linki z `target="_blank"`, kliknięcia z Ctrl/Cmd, kotwice `#…`, `mailto:`
  i `tel:` działają normalnie, a linki `target="_top"` otwierają się w podglądzie
  (zamiast podmieniać cały widok recenzji). To samo dotyczy projektów z ZIP-a.
- **Jeśli podgląd mimo to opuści recenzowaną stronę** (przekierowanie,
  formularz, plik, podstrona bez skryptu), widok to wykryje (warstwa adnotacji
  nie odpowie w ciągu ~3,5 s po wczytaniu) i przykryje podgląd komunikatem
  **„Utracono połączenie z recenzowaną stroną”** z przyciskiem
  **„Powrót”** (pełny adres ostatniej poprawnej strony jest w podpowiedzi
  przycisku). Komentowanie jest wtedy wstrzymane.
- Jeśli strona nie odpowie **już przy pierwszym wczytaniu**, komunikat
  **„Strona nie odpowiada”** podpowiada, że brakuje skryptu albo strona blokuje
  wyświetlanie w ramce.

Wymagania i ograniczenia:

- Design Review musi być dostępny **publicznie przez HTTPS** (strona na `https://`
  nie wczyta skryptu z `http://` ani z `localhost`) – ustaw też `PUBLIC_URL`.
- Strona nie może blokować wyświetlania w ramce nagłówkami `X-Frame-Options`
  albo CSP `frame-ancestors` (dodają je czasem wtyczki bezpieczeństwa, hosting
  lub Cloudflare). Skrypt tego nie obejdzie – w takim przypadku potrzebna jest
  zmiana konfiguracji albo plugin (planowany).
- Wtyczki optymalizujące (WP Rocket, Autoptimize, LiteSpeed): wyklucz
  `annotator.js` z łączenia i opóźniania skryptów (najlepiej po nazwie pliku).
- Jeśli recenzowana strona ma własną politykę **CSP**, musi dopuszczać warstwę
  adnotacji: `script-src` – origin aplikacji (wczytanie `/annotator.js`),
  `style-src` – `'unsafe-inline'` (warstwa wstrzykuje własny element `<style>`),
  `frame-ancestors` – origin aplikacji. Bez tego skrypt się nie wczyta albo
  nakładka nie dostanie stylów i znaczniki będą niewidoczne.
- Recenzować da się strony dostępne publicznie. Podgląd wersji roboczych
  (`?preview=true`) wymaga zalogowania do WordPressa, a ciasteczka logowania
  nie są wysyłane w ramce z innej domeny.

### Podmiana plików (nowa wersja)

Ikona **🔄** przy projekcie pozwala wgrać nowe archiwum ZIP do **istniejącej**
strony:

- link do recenzji (`/v/<id>`) się nie zmienia,
- hasło dostępu i wszystkie komentarze zostają,
- pliki starej wersji są usuwane, a na ich miejsce wchodzi nowe archiwum,
- jeśli nowy ZIP jest nieprawidłowy, podmiana jest przerywana i **stara wersja
  pozostaje nietknięta**,
- komentarze, których miejsc nie da się już odnaleźć po zmianie struktury,
  nadal są widoczne na liście — z ostrzeżeniem.

### Widok recenzji `/v/<id>`

- jeśli strona ma ustawione hasło, najpierw pojawia się ekran
  **„Strona zabezpieczona”** (`/unlock/<id>`) z polem hasła; po jego podaniu
  przechodzisz od razu do widoku recenzji (właściciel widzi ją bez hasła),
- po lewej stronie w `<iframe>` renderowana jest wgrana strona,
- po prawej panel z komentarzami,
- **zaznaczenie tekstu** → nad zaznaczeniem pojawia się przycisk „Dodaj komentarz”,
- **Tryb pinezki** → kliknięcie w dowolnym miejscu stawia pinezkę; obok tego
  przycisku widnieje podpowiedź **„Zaznacz tekst, aby komentować”**,
- komentarze są przypisane do **konkretnego pliku HTML**. Panel pokazuje wpisy
  z całego projektu — przy komentarzu z innej podstrony widnieje jej nazwa
  (np. `about.html`); kliknięcie takiego wpisu **wczytuje tę podstronę**
  i od razu podświetla właściwy komentarz,
- kliknięcie wpisu na liście wyróżnia odpowiadający mu komentarz w podglądzie:
  pinezka (razem z numerem) jest powiększona do 120% i przybiera wyraźny
  **różowy kolor `#ee3a70`** (ten sam, co emoji 📌 w pasku), a wokół niej
  rozchodzi się fala w tym kolorze. Przy komentarzach przypiętych do elementu
  dodatkowo rysowana jest **obwódka wokół tego elementu** — od razu widać,
  czego dotyczy uwaga. Wyróżnienie pozostaje widoczne aż do wybrania innego
  komentarza, a widok przewija się do właściwego miejsca,
- kliknięcie istniejącej pinezki lub podświetlenia w podglądzie zaznacza
  odpowiedni wpis na liście,
- **⬇ ZIP** – pobranie plików projektu jako archiwum ZIP (bez komentarzy;
  to dokładnie te pliki, które znalazły się w przesłanym archiwum),
- komentarze można **oznaczyć jako rozwiązany** i **usunąć**,
- przycisk **Ukryj rozwiązane** ukrywa komentarze oznaczone jako rozwiązane —
  zarówno na liście, jak i w podglądzie strony. Wybór jest zapamiętywany
  w przeglądarce.

### Wgrywanie ZIP

- Plik startowy wykrywany jest automatycznie: preferowany `index.html`,
  w drugiej kolejności najpłycej położony plik HTML. Działa też ZIP ze stroną
  w podkatalogu (np. `moj-projekt/index.html`) — ścieżki względne zasobów pozostają poprawne.
- Zasoby (CSS, JS, obrazy, fonty) są serwowane pod `/p/<id>/...` z poprawnymi typami MIME.
- Chronione przed „zip slip” — wpisy wychodzące poza katalog docelowy są pomijane.
- Do każdego dokumentu HTML wstrzykiwany jest skrypt warstwy adnotacji
  (`/annotator.js`), a nagłówki `meta` z CSP są usuwane, aby nie blokowały tego skryptu.

## Kotwiczenie komentarzy

Każdy komentarz zapisuje plik, w którym powstał (`page`, np. `index.html` albo
`podstrona/o-nas.html`; dla stron na żywo – ścieżkę adresu, np. `/oferta/`). Warstwa adnotacji otrzymuje **wyłącznie komentarze
aktualnie otwartej podstrony**, więc XPath z jednego pliku nie trafia
w przypadkowy element innego — nawet gdy obie strony mają identyczną strukturę.
Zmiana podstrony w podglądzie (kliknięcie linku albo komentarza z listy)
automatycznie przełącza też listę i numerację pinezek.

- **Pinezka** – zakotwiczona do **klikniętego elementu**: zapisywana jest ścieżka
  XPath tego elementu oraz położenie kliknięcia jako ułamek jego szerokości
  i wysokości. Dzięki temu przy zmianie rozmiaru okna (i przebudowie układu)
  pinezka pozostaje w tym samym miejscu elementu. Dodatkowo zapisywane są
  bezwzględne współrzędne dokumentu, używane gdy elementu nie da się już
  odnaleźć (np. po zmianie struktury strony).
- **Tekst** – ścieżka XPath początku i końca zakresu + offsety znaków (+ treść
  zaznaczenia jako zapas). Przy odczycie zakres jest odtwarzany i używany tylko
  wtedy, gdy nadal obejmuje zapisany tekst; jeśli strona się zmieniła, używane
  jest awaryjne wyszukiwanie tekstu. Gdy i to zawiedzie, komentarz nadal jest
  widoczny na liście z ostrzeżeniem „Nie można odnaleźć tego miejsca na stronie”.

### Ukryte miejsca (akordeony, zakładki, karuzele)

Komentarz może dotyczyć miejsca, którego chwilowo nie widać: treści zwiniętego
akordeonu (`<details>` w Atomic v4 albo klasyczny akordeon), nieaktywnej
zakładki czy slajdu poza kadrem karuzeli. Warstwa adnotacji:

- **nie rysuje podświetleń w ukrytych miejscach** – zaznaczenie obejmujące
  tytuł akordeonu i jego zwiniętą treść podświetla tylko tytuł; fragmenty
  przycięte przez kontener z ukrytym przepełnieniem (np. kadr karuzeli) też
  są pomijane,
- **pinezkę zostawia widoczną** – stoi w najbliższym widocznym miejscu (dolna
  krawędź tytułu akordeonu, widoczna zakładka, brzeg kadru karuzeli) i ma
  przerywany obrys; tak samo numer komentarza tekstowego, gdy cały tekst
  jest ukryty,
- na liście komentarzy dopisuje „Miejsce jest teraz ukryte na stronie” (bez
  czerwonego ostrzeżenia – miejsce istnieje, tylko go nie widać),
- po kliknięciu komentarza w zwiniętym `<details>` **sam rozwija akordeon**
  i przewija do komentarza (akordeonów sterowanych skryptem, np. klasycznego
  akordeonu Elementora, nie rozwija),
- przy tworzeniu zaznaczenia wychodzącego poza widoczny tekst zapisuje tylko
  jego widoczną część.

Za ukryte nie jest uznawany tekst o przezroczystości 0 – od niej startują
animacje wejścia Elementora.

### Strony zbudowane w Elementorze

XPath rozjeżdża się, gdy ktoś doda sekcję wyżej albo przesunie blok. Dlatego
na stronach z Elementorem (klasycznym i Atomic v4) kotwica zapisuje dodatkowo
**`data-id` najbliższego elementu Elementora**, **numer jego wystąpienia** na
stronie i **ścieżkę od niego do celu** (`eid: { id, n, rel }` – w pinezce
w `target.eid`, w zaznaczeniu tekstu w `startEid` / `endEid`). Przy odczycie:

1. jeden element z tym `data-id` → komentarz trafia do niego,
2. kilka elementów (Loop Grid, globalne widżety, kilkakrotnie wstawiony
   szablon) → ten egzemplarz, który zawiera miejsce wskazane przez XPath,
   a gdy żaden – egzemplarz o zapisanym numerze wystąpienia,
3. brak elementu albo ścieżki → XPath, a potem współrzędne / wyszukiwanie tekstu.

Kopie tworzone przez skrypty strony – powielone slajdy karuzel w pętli
(`.swiper-slide-duplicate`, `.slick-cloned`) i wypełniacz przyklejanego nagłówka
(`.elementor-sticky__spacer`) – są pomijane. Uwzględniane są tylko elementy
z `data-id` oznaczone przez Elementor (`data-element_type`, `data-e-type` albo
klasa `elementor-element`). Komentarze zapisane wcześniej, bez `eid`, działają
jak dotąd.

## Struktura projektu

```
server.js              API + serwowanie stron + wstrzykiwanie warstwy adnotacji
lib/store.js           magazyn danych (pliki JSON na dysku)
lib/auth.js            logowanie uid-em + ochrona strony głównej
lib/zip.js             bezpieczne rozpakowywanie ZIP, wykrywanie pliku startowego i pakowanie archiwum
lib/mime.js            mapa typów MIME
lib/notify.js          powiadomienia mailowe o nowych komentarzach (zbieranie i wysyłka)
public/index.html      strona główna (lista stron, upload)
public/app.js          logika strony głównej
public/login.html      ekran logowania (jedno pole: uid)
public/login.js        logika logowania
public/unlock.html     ekran wpisywania hasła do zabezpieczonej strony
public/unlock.js       logika odblokowywania strony
public/dialog.js       wspólne okno potwierdzenia w stylu aplikacji
public/view.html       widok recenzji
public/view.js         logika widoku recenzji (panel komentarzy)
public/annotator.js    warstwa adnotacji działająca wewnątrz podglądanej strony (także wklejana na strony na żywo)
public/styles.css      style interfejsu
scripts/smoke-test.js  testy „dymne” API
data/                  db.json + komentarze + config.json (tworzone automatycznie)
sites/                 rozpakowane strony (tworzone automatycznie)
sample/landing.zip     przykładowa strona do testów
```

## API

| Metoda | Ścieżka | Dostęp | Opis |
| --- | --- | --- | --- |
| `POST` | `/api/login` | publiczny | logowanie: `{ "uid": "…" }`, ustawia ciasteczko sesji |
| `POST` | `/api/logout` | publiczny | wylogowanie (czyści ciasteczko) |
| `GET` | `/api/session` | publiczny | `{ authed, uid }` – stan zalogowania dla interfejsu |
| `GET` | `/api/notifications` | **tylko zalogowany** | stan powiadomień mailowych (`enabled`, adres, tryb, czasy) |
| `POST` | `/api/notifications/test` | **tylko zalogowany** | wysyłka testowego maila |
| `GET` | `/api/projects` | **tylko zalogowany** | lista stron + `snippet` (skrypt do wklejenia na stronach na żywo) |
| `POST` | `/api/projects` | **tylko zalogowany** | upload ZIP (`multipart/form-data`: `file`, opcjonalnie `name`) |
| `POST` | `/api/projects/url` | **tylko zalogowany** | strona na żywo: `{ "url": "https://…", "name": "…" }` (nazwa opcjonalna); zwraca projekt i `snippet` |
| `POST` | `/api/projects/:id/replace` | **tylko zalogowany** | podmiana plików istniejącej strony (`multipart/form-data`: `file`); link, hasło i komentarze bez zmian; nie dotyczy stron na żywo |
| `DELETE` | `/api/projects/:id` | **tylko zalogowany** | usunięcie strony wraz z komentarzami |
| `POST` | `/api/projects/:id/password` | **tylko zalogowany** | ustawienie (`{ "password": "…" }`) lub usunięcie (`""`) hasła strony |
| `GET` | `/api/projects/:id/access` | publiczny | `{ name, locked, unlocked }` – stan dostępu do strony (dla ekranu hasła) |
| `POST` | `/api/projects/:id/unlock` | publiczny | odblokowanie strony hasłem (`{ "password": "…" }`), ustawia ciasteczko |
| `GET` | `/api/projects/:id` | publiczny\* | szczegóły strony + komentarze |
| `GET` | `/api/projects/:id/archive` | publiczny\* | archiwum ZIP z plikami strony (bez komentarzy); nie dotyczy stron na żywo |
| `GET` | `/api/projects/:id/comments` | publiczny\* | lista komentarzy |
| `POST` | `/api/projects/:id/comments` | publiczny\* | dodanie komentarza |
| `PATCH` | `/api/projects/:id/comments/:commentId` | publiczny\* | zmiana treści / statusu „rozwiązany” |
| `DELETE` | `/api/projects/:id/comments/:commentId` | publiczny\* | usunięcie komentarza |
| `GET` | `/v/:id` | publiczny\* | widok recenzji (`?c=<id komentarza>` – otwiera jego podstronę i wyróżnia go) |
| `GET` | `/p/:id/...` | publiczny\* | pliki wgranej strony |

Endpointy oznaczone jako **tylko zalogowany** odpowiadają `401`, gdy brakuje
ważnego ciasteczka sesji. `*` – jeśli strona ma ustawione hasło, wymagane jest
wcześniejsze odblokowanie (albo sesja właściciela); w przeciwnym razie API
zwraca `401`, a pliki strony `403`.

Przykład dodania komentarza typu pinezka:

```json
{
  "author": "Anna",
  "text": "Ten przycisk powinien być większy.",
  "type": "pin",
  "page": "index.html",
  "anchor": {
    "x": 120, "y": 340,
    "docWidth": 1200, "docHeight": 2400,
    "target": {
      "xpath": "/body[1]/main[1]/button[1]",
      "fx": 0.5,
      "fy": 0.25
    }
  }
}
```

Pole `target` jest opcjonalne — `fx`/`fy` to położenie pinezki jako ułamek
szerokości i wysokości elementu wskazanego przez `xpath`.

Pole `page` wskazuje plik HTML względem katalogu projektu i musi istnieć
w przesłanym archiwum. Jest opcjonalne — bez niego komentarz trafia na stronę
startową (tak zachowują się komentarze zapisane przed wprowadzeniem podstron).

Dla stron na żywo `page` to ścieżka adresu (np. `/oferta/` albo `/?p=123`) –
musi zaczynać się od `/` i wskazywać tę samą domenę (lub jej wariant z `www.`).
Opcjonalne pole `postId` (dodatnia liczba całkowita) to ID wpisu WordPressa.

Przykład komentarza do tekstu:

```json
{
  "author": "Bartek",
  "text": "Skróć to zdanie.",
  "type": "text",
  "page": "about.html",
  "anchor": {
    "startXPath": "/body[1]/main[1]/p[1]/text()[1]",
    "startOffset": 0,
    "endXPath": "/body[1]/main[1]/p[1]/text()[1]",
    "endOffset": 30,
    "text": "Acme pomaga zespołom produktowym"
  }
}
```

## Testy

Przy działającym serwerze:

```bash
npm test
```

Skrypt `scripts/smoke-test.js` sprawdza logowanie i blokadę dostępu, upload,
wstrzykiwanie warstwy adnotacji, poprawność typów MIME, dodawanie i usuwanie
komentarzy, przypisanie komentarzy do podstron (walidacja ścieżki i pliku),
archiwum ZIP, podmianę plików bez zmiany linku (nowa treść, usunięcie starych
plików, zachowanie komentarzy i hasła, odrzucenie błędnego archiwum),
hasło dostępu do strony (blokada widoku,
plików i API, błędne/poprawne hasło, unieważnienie po zmianie), strony na żywo
(walidacja adresu, skrypt do wklejenia bez wersji, klucze podstron, ID wpisu,
odrzucanie obcych domen i kluczy wskazujących inny host, nagłówki cache warstwy
adnotacji, kotwice Elementora, brak ZIP-a i plików pod `/p/`) oraz
zabezpieczenie przed path traversal. Uid do logowania bierze z `data/config.json`
(albo ze zmiennej `ADMIN_UID`).

Testy powiadomień mailowych (zbieranie komentarzy, pomijanie komentarzy
właściciela, czas maksymalny, treść i linki, mail testowy) uruchamiają się
tylko na serwerze w trybie zapisu do pliku z krótkimi czasami – w innym
przypadku są pomijane:

```bash
MAIL_TRANSPORT=log NOTIFY_EMAIL=test@example.com NOTIFY_QUIET_MS=1500 NOTIFY_MAX_MS=4000 NOTIFY_TICK_MS=250 npm start
```

## Bezpieczeństwo i ograniczenia

- Strona główna i operacje na projektach są chronione uid-em, ale **dodawanie,
  zmiana i usuwanie komentarzy jest publiczne** — każdy, kto zna link do
  recenzji, może komentować (i usuwać komentarze). Takie były założenia:
  recenzenci nie zakładają kont. Jeśli to zbyt szeroko, warto ograniczyć
  `PATCH`/`DELETE` komentarzy do właściciela.
- Hasło strony trzymane jest jako skrót **scrypt** (losowa sól, 64-bajtowy
  klucz), a dostęp potwierdza osobne ciasteczko z losowym tokenem ważne 30 dni.
  Hasło chroni stronę i jej komentarze, ale **nie jest kontem**: każdy, kto je
  zna, ma te same uprawnienia co inni recenzenci. Zmiana hasła unieważnia
  wcześniejsze odblokowania.
- Uid to jedyne hasło. Trzymany jest w `data/config.json`; sesja w ciasteczku
  `httpOnly`. Brak HTTPS w wbudowanym serwerze — w sieci, której nie kontrolujesz,
  postaw go za odwrotnym proxy z TLS-em.
- Wgrane strony są serwowane z tego samego origin co aplikacja, więc skrypt
  wgranej strony ma dostęp do jej interfejsu. Nie wgrywaj niezaufanych archiwów.
  W środowisku produkcyjnym warto rozdzielić je na osobną domenę.
- Strony na żywo działają na własnej domenie, więc nie mają dostępu do interfejsu
  aplikacji. Skrypt wklejony na stronie wysyła wiadomości wyłącznie pod adres
  Design Review i przyjmuje polecenia tylko od niego; widok recenzji przyjmuje
  wiadomości tylko z domeny projektu (i jej wariantu `www.`). Hasło projektu
  chroni widok recenzji i komentarze — sama strona WordPress pozostaje publiczna.
- Limity: 50 MB na plik ZIP, 5000 plików, 300 MB po rozpakowaniu.
- Dane trzymane są w plikach (`data/`, `sites/`) — kopię zapasową robi się
  przez skopiowanie tych katalogów. Backupy nie są tworzone automatycznie.
