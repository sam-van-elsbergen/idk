Overlay Upload Tool (no API, no scraping)

Wat dit is
- Alleen uploads -> moderation dashboard -> overlay
- Geen YouTube API
- Geen scraping
- Geen GIF uploads
- Realtime updates via WebSocket, dus geen refresh spam
- Dashboard kan ook handmatig een melding naar de overlay sturen

Run lokaal
1) Start de server:
   node server.js --admin=YOUR_ADMIN_TOKEN --uploadKey=YOUR_UPLOAD_KEY --bind=0.0.0.0 --port=3000

2) Open:
   Overlay:   http://127.0.0.1:3000/overlay.html
   Dashboard: http://127.0.0.1:3000/dashboard.html?token=YOUR_ADMIN_TOKEN
   Upload:    http://127.0.0.1:3000/upload.html?k=YOUR_UPLOAD_KEY

Opmerkingen
- --uploadKey is optioneel, maar sterk aangeraden als je de uploadpagina publiek deelt.
- Alleen PNG, JPG en WEBP zijn toegestaan.
- Browser notifications in het dashboard moet je één keer toestaan.

Cloudflared
1) Start je app:
   node server.js --admin=YOUR_ADMIN_TOKEN --uploadKey=YOUR_UPLOAD_KEY --bind=0.0.0.0 --port=3000

2) Test met een quick tunnel:
   cloudflared tunnel --url http://127.0.0.1:3000

3) Vaste tunnel maken:
   cloudflared tunnel login
   cloudflared tunnel create overlay-bot

4) Config bestand maken (~/.cloudflared/config.yml):
   tunnel: overlay-bot
   credentials-file: /root/.cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: overlay.jouwdomein.nl
       service: http://127.0.0.1:3000
     - service: http_status:404

5) DNS koppelen
   Maak in Cloudflare een CNAME voor overlay.jouwdomein.nl naar:
   <TUNNEL-ID>.cfargotunnel.com

6) Tunnel starten:
   cloudflared tunnel run overlay-bot

Met een eigen domein van Mijndomein
- Je kunt je domein gewoon bij Mijndomein houden.
- Het makkelijkst is je DNS voor een subdomein door Cloudflare te laten beheren.
- Gebruik bijvoorbeeld:
  overlay.jouwdomein.nl  -> dashboard en overlay
- Daarna deel je:
  https://overlay.jouwdomein.nl/overlay.html
  https://overlay.jouwdomein.nl/dashboard.html?token=YOUR_ADMIN_TOKEN
  https://overlay.jouwdomein.nl/upload.html?k=YOUR_UPLOAD_KEY

Veiligheid
- Zet een sterk admin token.
- Deel de dashboard-link nooit publiek.
- Gebruik een aparte upload key voor kijkers.


Defaults:
- Admin token default = goodboy
- Upload key disabled by default

Run locally or on Render:
node server.js
