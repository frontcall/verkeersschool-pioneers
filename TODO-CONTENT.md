# TODO — Content aanleveren voor launch

Zoek alle placeholders met: `grep -r "data-todo" src/`

## Nog aan te leveren

- [ ] **Logo** (SVG of PNG, transparante achtergrond)
  → Vervang de tekst-wordmark in `src/components/Header.astro` en `src/components/Footer.astro`

- [ ] **WhatsApp-nummer** van Mahmood
  → Zoek op `whatsapp-number-pending` — staat in 4 bestanden

- [ ] **Telefoonnummer**
  → Zoek op `phone-number-pending` — Footer + Contact pagina

- [ ] **E-mailadres**
  → Zoek op `email-pending` — Footer + Contact pagina

- [ ] **Adres** (straat + huisnummer)
  → Zoek op `address-pending` — Footer + Contact pagina

- [ ] **KVK-nummer**
  → Zoek op `kvk-number-pending` — Footer.astro

- [ ] **Google Sheet URL** met definitieve prijzen
  → `.env.example` → maak `.env` aan met `PUBLIC_PRICING_SHEET_URL`
  → Fase 3 implementeert de koppeling

- [ ] **Social media links** (TikTok, Instagram, Facebook)
  → Zoek op `social-link-pending` — Footer.astro

- [ ] **Google Bedrijfsprofiel link** (voor de Reviews-sectie)
  → Zoek op `google-profile-link-pending` — reviews.astro

- [ ] **Foto's** (instructeurs, lesauto's, actiefoto's)
  → Over-ons pagina → vervang de placeholder-vakken

- [ ] **Instructeur-namen en bio's**
  → Zoek op `instructor-cards-pending` — over-ons.astro

- [ ] **FAQ-antwoorden** (betaalopties, lesduur, examenkosten, etc.)
  → pakketten.astro onderaan

- [ ] **Echte Google Reviews** (vervang placeholder-reviews)
  → src/pages/reviews.astro én src/pages/index.astro

- [ ] **Over ons tekst** (definitieve copy van Mahmood)
  → Zoek op `about-story-pending` — over-ons.astro

- [ ] **Google Maps embed** (bij definitief adres)
  → Zoek op `map-embed-pending` — over-ons.astro + contact.astro
