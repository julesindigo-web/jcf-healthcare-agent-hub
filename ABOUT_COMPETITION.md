# 🚀 Panduan Publish & Invokable di Prompt Opinion Platform

## Gambaran Alur (5 Langkah Wajib)

Alur resmi dari Prompt Opinion untuk hackathon ini adalah: **Register → Build → Integrate → Publish → Submit.**

---

## STEP 1 — Daftar Akun Prompt Opinion

Buat akun gratis di Prompt Opinion melalui **`app.promptopinion.ai`**.

Ini wajib — tanpa akun kamu tidak bisa mengakses marketplace maupun mempublikasikan proyekmu.

---

## STEP 2 — Tentukan Jalur Publikasimu

Proyekmu masuk **Path A (MCP Server)** karena memiliki 59 tools via JSON-RPC 2.0. Berikut penjelasan resminya:

**Path A — Build a Superpower (MCP):** Buat MCP server yang mengekspos sekumpulan tools spesifik. Dengan membangun MCP, kamu membuat kapabilitas yang bisa digunakan oleh *agen mana pun* di ekosistem.

**Path B — Build an Agent (A2A):** Tidak wajib jadi developer A2A — Prompt Opinion mendukung pengembangan agen langsung di dalam platform tanpa kode. Platform menangani komunikasi kompleks secara native.

Karena proyekmu mengimplementasikan **keduanya** (MCP + A2A), kamu bisa submit sebagai MCP Server sambil menonjolkan A2A Bridge sebagai keunggulan tambahan.

---

## STEP 3 — Integrasikan SHARP Extension Specs ⚠️ KRITIS

Ini bagian yang paling sering terlewat oleh peserta!

Pastikan solusimu menggunakan **SHARP Extension Specs** untuk menangani healthcare context seperti **patient IDs dan FHIR tokens**. Meskipun tidak diwajibkan, sangat direkomendasikan untuk menggunakan data dari **FHIR server** dalam solusimu.

Platform menjembatani EHR session credentials langsung ke dalam SHARP context, sehingga kamu tidak perlu membuat solusi token-handling sendiri.

**Apa artinya untuk proyekmu?** MCP server-mu harus bisa menerima dan meneruskan SHARP context (patient ID, FHIR token) yang dikirim oleh platform ketika di-invoke dari dalam Prompt Opinion. Ini adalah "handshake" antara proyekmu dan platform.

---

## STEP 4 — Publish ke Prompt Opinion Marketplace

Konfigurasikan dan **publish proyekmu ke Prompt Opinion Marketplace** agar bisa di-discover dan di-invoke dari dalam platform.

Ada **dua cara** untuk membuat proyekmu tersedia di marketplace:

**Cara A — Daftarkan MCP Server Eksternalmu:**
Karena proyekmu sudah berjalan sebagai MCP server mandiri (Node.js + stdio), kamu perlu mendaftarkan endpoint-nya ke platform. Ini berarti:
- MCP server-mu harus **publicly accessible** (bukan localhost)
- Deploy ke cloud: Railway, Render, Fly.io, atau VPS — agar platform bisa menjangkaunya
- Daftarkan URL endpoint MCP-mu di Prompt Opinion dashboard

**Cara B — Build Native Agent di Platform:**
Kamu juga bisa mengkonfigurasi A2A agent langsung di dalam platform tanpa kode apapun.

**Rekomendasi untuk proyekmu:** Gunakan Cara A (daftarkan MCP server eksternal) karena proyekmu sudah production-grade dengan 59 tools.

---

## STEP 5 — Verifikasi: Discoverable & Invokable

Ini adalah **kriteria Pass/Fail Stage 1** yang paling penting. Setelah publish, pastikan:

- [ ] Proyekmu **muncul di Marketplace** Prompt Opinion saat dicari
- [ ] Juri bisa **mengklik dan menginvoke** tools-mu langsung dari platform
- [ ] Respons tool-mu **terlihat di dalam interface** Prompt Opinion
- [ ] Tidak ada error saat platform memanggil MCP tools-mu

---

## STEP 6 — Submit ke Devpost

Setelah semua di atas selesai, kembali ke Devpost dan isi:

- URL proyek di Prompt Opinion Marketplace ✅
- Deskripsi teks fitur & fungsi ✅
- Link video demo YouTube/Vimeo (maks 3 menit) ✅

---

## ⚡ Tips Deployment Cepat (Deadline 11 Mei!)

Karena proyekmu Node.js + TypeScript, cara termudah untuk deploy secara publik:

```bash
# Opsi 1: Railway (paling cepat, gratis tier)
railway login
railway init
railway up

# Opsi 2: Render (free tier, auto-deploy dari GitHub)
# Push ke GitHub → connect ke render.com → deploy

# Opsi 3: Fly.io
fly launch
fly deploy
```

Setelah deployed, kamu akan mendapat URL publik seperti `https://jcf-healthcare.railway.app` — URL inilah yang didaftarkan ke Prompt Opinion sebagai MCP endpoint-mu.

---

## 🆘 Butuh Bantuan Teknis?

Prompt Opinion memiliki **Discord Channel** khusus untuk hackathon ini di `discord.gg/JS2bZVruUg` — ini adalah tempat terbaik untuk bertanya langsung kepada tim Prompt Opinion soal cara publish dan integrasi teknis.

**Saran langsung:** Join Discord mereka sekarang dan tanya spesifik soal cara mendaftarkan MCP server eksternal ke marketplace mereka — ini akan menghemat berjam-jam trial-and-error dengan deadline yang tinggal beberapa hari.