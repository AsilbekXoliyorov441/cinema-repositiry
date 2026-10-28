# CineWave API — serverga joylash (deploy)

Bitta Docker image uchta rolda ishlaydi: `migrate` (Prisma migratsiyalari), `api` (HTTP) va `worker` (BullMQ joblari).
PostgreSQL va Redis ham shu `docker-compose.yml` ichida.

## 1. Server tayyorlash (Ubuntu 22.04/24.04)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # qayta login qiling
sudo apt install -y nginx certbot python3-certbot-nginx
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

DNS: `api.example.com` A-yozuvi server IP manziliga yo'nalgan bo'lishi kerak.

## 2. Kodni yuklash va sozlash

```bash
git clone <repo> /opt/cinewave && cd /opt/cinewave/cinewave-backend
cp .env.production.example .env.production
```

`.env.production` ichida to'ldiring (bo'sh qoldirib bo'lmaydi):

| O'zgaruvchi | Qanday yaratish |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | har biri alohida `openssl rand -hex 48` |
| `MFA_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `PLAYBACK_SIGNING_SECRET` | `openssl rand -hex 32` |
| `APP_URL`, `FRONTEND_URL`, `ADMIN_URL`, `COOKIE_DOMAIN` | haqiqiy domenlaringiz |
| `SMTP_*`, `EMAIL_FROM` | pochta provayderi (production'da `smtp` majburiy) |
| `STRIPE_*` | faqat `PAYMENT_PROVIDER=stripe` bo'lsa |

Ilova noto'g'ri production sozlamalari bilan **ishga tushmaydi** va qaysi o'zgaruvchi xato ekanini logga yozadi
(`docker compose logs api`).

## 3. Ishga tushirish

Compose `POSTGRES_*` qiymatlarini `.env.production` dan olishi uchun `--env-file` beriladi:

```bash
alias dc='docker compose --env-file .env.production --profile app'
dc up -d --build          # image build → migrate → api → worker
dc ps                     # hammasi "healthy"/"running" bo'lishi kerak
curl -s http://127.0.0.1:4000/health/ready
```

Boshlang'ich ma'lumotlar (rollar, ruxsatlar, tariflar; demo foydalanuvchilar productionda yaratilmaydi):

```bash
dc run --rm api node dist/cli/seed.js
```

Birinchi SUPER_ADMIN (interaktiv so'raydi, faqat bir marta ishlaydi):

```bash
dc run --rm -it api node dist/cli/bootstrap-admin.js
```

## 4. Nginx + HTTPS

Avval sertifikat olinadi (config 443-blokida sertifikat fayllari bo'lishi kerak), keyin config ulanadi:

```bash
sudo certbot certonly --nginx -d api.SIZNING-DOMEN.uz
sudo cp deploy/nginx/cinewave-api.conf /etc/nginx/sites-available/cinewave-api
sudo sed -i 's/api.example.com/api.SIZNING-DOMEN.uz/g' /etc/nginx/sites-available/cinewave-api
sudo ln -s /etc/nginx/sites-available/cinewave-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Nginx orqasida `TRUST_PROXY=1` bo'lishi shart (shablonda allaqachon shunday) — aks holda rate-limit va audit
loglar mijoz IP manzilini noto'g'ri ko'radi.

Stripe ishlatilsa, webhook URL: `https://api.SIZNING-DOMEN.uz/api/v1/webhooks/stripe`.

## 5. Yangilash

```bash
git pull
dc up -d --build     # migratsiyalar avtomatik qo'llanadi, keyin api/worker qayta ishga tushadi
docker image prune -f
```

## 6. Zaxira nusxa (backup)

```bash
# Ma'lumotlar bazasi
docker compose exec -T postgres pg_dump -U cinewave -Fc cinewave > backup-$(date +%F).dump
# Tiklash
docker compose exec -T postgres pg_restore -U cinewave -d cinewave --clean < backup-YYYY-MM-DD.dump
# Yuklangan rasmlar (volume)
docker run --rm -v cinewave_uploads:/data -v "$PWD":/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .
```

Kunlik backup uchun yuqoridagilarni `crontab -e` ga qo'shing va fayllarni serverdan tashqariga ko'chiring.

## 7. Foydali buyruqlar

```bash
dc logs -f api worker         # loglar (JSON, pino)
dc restart api
dc exec postgres psql -U cinewave cinewave
```

PostgreSQL (5433), Redis (6380) va API (4000) portlari faqat `127.0.0.1` ga ochilgan — tashqaridan faqat nginx
orqali kiriladi.
