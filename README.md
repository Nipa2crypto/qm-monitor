# QM Monitor

V2 mit:
- Bild-Upload pro Fall
- mobilem Web-Layout
- Mechaniker-Kürzel
- Maßnahme intern
- Maßnahme Kundenzufriedenheit
- Fall abgeschlossen ✔️
- optionalem E-Mail-Versand bei neuem Fall / Eskalation / Fälligkeit
- optionaler Wochenübersicht per Mail

## Render
- Web Service aus diesem Repo erstellen
- zusätzlich Render Postgres anlegen
- `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` setzen
- für Mail zusätzlich `SMTP_*`

## Wichtige Hinweise
- Bild-Uploads werden in dieser Version direkt in Postgres gespeichert. Für euren kleinen Umfang ist das okay, für später wäre Object Storage besser.
- Wochenübersicht und Fälligkeitsmails laufen per in-App-Cron. Auf schlafenden Free-Instanzen ist das nicht zuverlässig. Dafür später besser Starter oder separaten Cron Job nutzen.
