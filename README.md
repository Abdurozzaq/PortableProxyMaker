# PortableProxyMaker

Pabrik proxy HTTP/HTTPS multi-port + inspector traffic, jalan di Docker (Ubuntu Server).

- Bikin banyak proxy, masing-masing di port sendiri (satu-satu atau bulk sampai 50 sekaligus).
- Port kena blacklist? Klik **Rotate**: proxy pindah ke port acak baru, user/password tetap sama, port lama masuk daftar **banned** supaya tidak dipakai lagi.
- **Ping** dari browser kamu untuk cek port masih bisa diakses dari jaringanmu.
- Monitoring traffic live: method, URL, status code, header request & response, body request & response (JSON di-pretty-print, gzip/br/deflate otomatis di-decode, gambar di-preview), durasi, ukuran, client IP, error. Bisa **Copy as cURL** untuk replay.
- HTTPS bisa di-decrypt dengan mode **MITM** (client harus trust CA dari panel). Tanpa MITM, HTTPS tetap jalan sebagai tunnel (hanya host, durasi, dan byte yang terlihat).
- Proxy auth (Basic), WebSocket, outbound IP per proxy (kalau server punya banyak IP).
- Panel neobrutalism, light/dark mode, responsive.

## Install di Ubuntu Server

```bash
# copy folder ini ke server, lalu:
cd PortableProxyMaker
sudo bash scripts/install.sh
```

Script akan: install Docker (kalau belum ada), bikin `.env` (isi `PUBLIC_HOST` otomatis + password admin acak), buka port di `ufw`, lalu `docker compose up -d --build`. Di akhir dia print URL panel dan login.

Manual:

```bash
cp .env.example .env      # edit PUBLIC_HOST, ADMIN_PASSWORD, range port
docker compose up -d --build
docker compose logs -f
```

Buka `http://IP-SERVER:8080`.

## Install di Windows (Docker Desktop)

Double-click `scripts\install.bat`, atau dari PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# opsi: -PanelPort 8080 -PortMin 20000 -PortCount 200 -PublicHost 192.168.1.50 -SkipFirewall
```

Dari Git Bash / MSYS2 (backslash dianggap escape di bash, jadi pakai `/`):

```bash
bash scripts/install.sh          # otomatis meneruskan ke install.ps1
# atau
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

Script akan: minta akses Administrator (untuk firewall), install Docker Desktop via `winget` kalau belum ada, menyalakan Docker Desktop dan menunggu engine-nya siap, bikin `.env` (IP LAN + password admin acak), buka port di Windows Firewall, `docker compose up -d --build`, lalu membuka panel di browser.

Perbedaan dengan Ubuntu:

- Docker Desktop tidak mendukung `network_mode: host`, jadi dipakai override [docker-compose.windows.yml](docker-compose.windows.yml) yang mem-publish port satu per satu. Karena itu range port default dibuat kecil (**200 port**, `20000-20199`). Range yang terlalu besar bikin container lambat start.
- `.env` berisi `COMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml`, jadi perintah `docker compose ...` biasa otomatis memakai override itu.
- Data disimpan di Docker volume `ppm-data` (bukan folder `data/`), karena SQLite tidak stabil di folder Windows yang di-mount. Backup: `docker compose cp proxymaker:/data .\backup`.
- Client IP di Traffic akan terlihat sebagai IP gateway Docker, bukan IP asli client.
- Kalau install Docker Desktop baru pertama kali, biasanya perlu restart Windows (WSL2). Setelah itu jalankan script lagi.
- Kalau mau ganti range port: edit `PROXY_PORT_MIN`/`PROXY_PORT_MAX` di `.env`, lalu jalankan installer lagi (rule firewall ikut diperbarui).

### Antivirus / proxy kantor yang mencegat HTTPS

Fitur HTTPS scanning antivirus (Avast, AVG, Kaspersky, ESET) atau proxy kantor (Zscaler, dll) me-re-sign semua HTTPS dengan root CA miliknya. Windows trust root itu, container Linux tidak. Gejalanya: build gagal di `npm ci` dengan `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `unable to verify the first certificate`.

`install.ps1` menangani ini otomatis: dia cek dari dalam container siapa yang me-re-sign HTTPS, mencari root CA-nya di PC (Avast/AVG menyimpannya di `C:\ProgramData\...\wscert.pem`, yang lain di Windows certificate store), lalu menyimpannya ke `certs\host-intercept-root.pem`. Semua `*.pem`/`*.crt` di folder [certs/](certs/) dipercaya oleh npm saat build dan oleh aplikasi saat jalan. Kalau root-nya tidak ketemu otomatis, export manual ke folder itu (format PEM) lalu `docker compose up -d --build`.

> **Firewall:** buka TCP port panel (`8080`) dan range port proxy (`20000-29999` default) di `ufw` **dan** di firewall/security group cloud provider (AWS, GCP, Vultr, dll).

## Cara pakai

1. **Proxies → + New proxy.** Kosongkan port untuk port acak, atau isi *How many* untuk bulk.
2. Klik **Copy** di kartu proxy → dapat `http://user:pass@IP:PORT`.
3. Pakai di client:
   ```bash
   curl -x http://user:pass@IP:PORT http://httpbin.org/get
   export HTTPS_PROXY=http://user:pass@IP:PORT
   ```
4. **Traffic** → klik baris untuk lihat detail Overview / Request / Response.
5. Port diblok → **Rotate** (centang *Ban port*). URL proxy baru otomatis ter-copy.

### Lihat isi HTTPS (MITM)

1. Edit proxy → nyalakan **Decrypt HTTPS (MITM)**.
2. **Settings → Download ca.crt**, install sebagai trusted root CA di device client (instruksi per OS ada di panel).
3. Kalau client belum trust CA, di Traffic akan muncul error `TLS handshake with client failed`.

Catatan: aplikasi yang memakai certificate pinning tidak bisa di-MITM; matikan MITM untuk proxy tersebut.

## Konfigurasi (`.env`)

| Variable | Default | Keterangan |
|---|---|---|
| `PANEL_PORT` | `8080` | Port panel web |
| `PANEL_HOST` | `0.0.0.0` | Set `127.0.0.1` kalau panel hanya diakses via SSH tunnel / reverse proxy |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / acak | Kalau password kosong, dibuat otomatis dan disimpan di `data/admin_password.txt` |
| `PUBLIC_HOST` | – | IP/domain publik server, dipakai untuk membentuk URL proxy |
| `PROXY_PORT_MIN` / `PROXY_PORT_MAX` | `20000` / `29999` | Range port acak untuk proxy baru & rotate |
| `UPSTREAM_TIMEOUT_MS` | `60000` | Timeout koneksi ke server tujuan |
| `MITM_VERIFY_UPSTREAM` | `true` | Verifikasi sertifikat server asli saat MITM. `false` untuk target self-signed |
| `CAPTURE_MAX_BODY` | `524288` | Maks byte body yang disimpan per request/response |
| `LOG_MAX_ROWS` / `LOG_RETENTION_HOURS` | `50000` / `72` | Batas penyimpanan log |

## Arsitektur

```
docker (network_mode: host)
└── node src/server.js
    ├── Panel + REST API + SSE live stream   :8080
    ├── ProxyInstance #1                       :2xxxx  ─┐
    ├── ProxyInstance #2                       :2xxxx   ├─> internet
    └── ...                                            ─┘
data/  (volume)
├── proxymaker.db      SQLite: proxy, banned port, traffic log
├── ca/ca.crt, ca.key  CA untuk MITM
├── admin_password.txt (kalau auto-generate)
└── session_secret.txt
```

- `network_mode: host` dipakai supaya port proxy yang dibuat dari panel langsung bisa diakses tanpa restart container / publish ulang port. Ini hanya berlaku di Docker Linux (Ubuntu), bukan Docker Desktop Windows/Mac.
- Semua proxy jalan di satu proses Node.js; tiap proxy adalah HTTP server di port sendiri.
- Log disimpan di SQLite bawaan Node 24 (`node:sqlite`), jadi tidak perlu build native module.

## Perintah berguna

```bash
docker compose logs -f              # log aplikasi
docker compose restart              # restart (proxy otomatis start lagi)
docker compose down                 # stop
docker compose up -d --build        # update setelah ganti kode
cat data/admin_password.txt         # lihat password admin auto-generate
```

Backup cukup copy folder `data/`.

## Keamanan

- Selalu pakai auth di proxy. Proxy tanpa auth = open proxy yang bisa dipakai siapa saja.
- Proxy bisa mengakses jaringan internal server (termasuk `127.0.0.1`). Jangan berikan kredensial proxy ke orang yang tidak dipercaya.
- Body yang di-capture bisa berisi token/password. Matikan *Capture bodies* kalau tidak perlu, dan jaga akses panel (`PANEL_HOST=127.0.0.1` + SSH tunnel atau reverse proxy HTTPS).
- File `data/ca/ca.key` adalah kunci CA: siapa pun yang memilikinya bisa memalsukan HTTPS untuk device yang trust CA ini.

## Development (tanpa Docker)

```bash
cd app
npm install
DATA_DIR=../data PANEL_PORT=8080 ADMIN_PASSWORD=dev npm run dev
```

Butuh Node.js ≥ 22.13.
