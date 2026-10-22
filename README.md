# Design Review

Aplikacja webowa do **komentowania designu stron HTML**. Wgrywasz stronę jako archiwum ZIP,
wysyłasz recenzentowi link, a on dodaje komentarze w dwóch trybach:

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
  **↗** sama strona w nowej karcie, **⬇** pobranie projektu jako ZIP,
  **🔒/🔓** hasło dostępu, **🗑** usunięcie strony wraz z komentarzami.
  Pełny opis każdej ikony pojawia się po najechaniu myszą. Usunięcie strony
  potwierdzasz oknem dialogowym w stylu aplikacji (nie natywnym oknem
  przeglądarki).

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
`podstrona/o-nas.html`). Warstwa adnotacji otrzymuje **wyłącznie komentarze
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
  zaznaczenia jako zapas). Przy odczycie zakres jest odtwarzany; jeśli strona się
  zmieniła, używane jest awaryjne wyszukiwanie tekstu. Gdy i to zawiedzie,
  komentarz nadal jest widoczny na liście z ostrzeżeniem
  „Nie można odnaleźć tego miejsca na stronie”.

## Struktura projektu

```
server.js              API + serwowanie stron + wstrzykiwanie warstwy adnotacji
lib/store.js           magazyn danych (pliki JSON na dysku)
lib/auth.js            logowanie uid-em + ochrona strony głównej
lib/zip.js             bezpieczne rozpakowywanie ZIP, wykrywanie pliku startowego i pakowanie archiwum
lib/mime.js            mapa typów MIME
public/index.html      strona główna (lista stron, upload)
public/app.js          logika strony głównej
public/login.html      ekran logowania (jedno pole: uid)
public/login.js        logika logowania
public/unlock.html     ekran wpisywania hasła do zabezpieczonej strony
public/unlock.js       logika odblokowywania strony
public/dialog.js       wspólne okno potwierdzenia w stylu aplikacji
public/view.html       widok recenzji
public/view.js         logika widoku recenzji (panel komentarzy)
public/annotator.js    warstwa adnotacji działająca wewnątrz podglądanej strony
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
| `GET` | `/api/projects` | **tylko zalogowany** | lista stron |
| `POST` | `/api/projects` | **tylko zalogowany** | upload ZIP (`multipart/form-data`: `file`, opcjonalnie `name`) |
| `DELETE` | `/api/projects/:id` | **tylko zalogowany** | usunięcie strony wraz z komentarzami |
| `POST` | `/api/projects/:id/password` | **tylko zalogowany** | ustawienie (`{ "password": "…" }`) lub usunięcie (`""`) hasła strony |
| `GET` | `/api/projects/:id/access` | publiczny | `{ name, locked, unlocked }` – stan dostępu do strony (dla ekranu hasła) |
| `POST` | `/api/projects/:id/unlock` | publiczny | odblokowanie strony hasłem (`{ "password": "…" }`), ustawia ciasteczko |
| `GET` | `/api/projects/:id` | publiczny\* | szczegóły strony + komentarze |
| `GET` | `/api/projects/:id/archive` | publiczny\* | archiwum ZIP z plikami strony (bez komentarzy) |
| `GET` | `/api/projects/:id/comments` | publiczny\* | lista komentarzy |
| `POST` | `/api/projects/:id/comments` | publiczny\* | dodanie komentarza |
| `PATCH` | `/api/projects/:id/comments/:commentId` | publiczny\* | zmiana treści / statusu „rozwiązany” |
| `DELETE` | `/api/projects/:id/comments/:commentId` | publiczny\* | usunięcie komentarza |
| `GET` | `/v/:id` | publiczny\* | widok recenzji |
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
archiwum ZIP, hasło dostępu do strony (blokada widoku,
plików i API, błędne/poprawne hasło, unieważnienie po zmianie) oraz
zabezpieczenie przed path traversal. Uid do logowania bierze z `data/config.json`
(albo ze zmiennej `ADMIN_UID`).

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
- Limity: 50 MB na plik ZIP, 5000 plików, 300 MB po rozpakowaniu.
- Dane trzymane są w plikach (`data/`, `sites/`) — kopię zapasową robi się
  przez skopiowanie tych katalogów. Backupy nie są tworzone automatycznie.
