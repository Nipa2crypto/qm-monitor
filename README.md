# QM Monitor

Kleine Mehrbenutzer-Web-App für Reklamations- und Prozessscreening.

## Enthalten
- Login mit Rollen (Admin / User)
- Fälle anlegen
- Fallliste mit Filtern
- Detailansicht mit Verlauf / Chronik
- Notizen / Maßnahmen
- Zuweisung, Priorität, Status, Fälligkeit
- persönliche Benachrichtigungseinstellungen
- Render-ready mit Postgres

## Lokal starten
```bash
cp .env.example .env
npm install
npm start
```

Dann im Browser öffnen:
`http://localhost:10000`

## Erforderliche Umgebungsvariablen
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

## Render
### Einfacher Weg
1. Repo zu GitHub pushen
2. In Render `New > Blueprint` oder `New > Web Service`
3. `render.yaml` im Repo nutzen
4. Secrets setzen:
   - `JWT_SECRET`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`

## Standard-Login
Beim ersten Start legt die App automatisch den Admin-User aus den Env-Variablen an.

## Wichtig
Diese V1 ist bewusst schlank.
Noch nicht enthalten:
- Mailversand
- Dateiuploads
- WebSockets / Live Push
- revisionssichere Audit-Historie
- SSO
