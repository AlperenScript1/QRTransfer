---
description: docs/SECURITY.md maddelerini kodla karşılaştıran güvenlik taraması
---

1. docs/SECURITY.md ve docs/PROTOCOL.md'yi oku.
2. Her numaralı madde (§2-§6) için tablo çıkar: madde | karşılayan dosya:satır | kanıtlayan test | durum (tamam/eksik/kısmi).
3. Kanıtı (test veya net kod referansı) olmayan maddeyi "eksik" say; tahminle "tamam" yazma.
4. Şunları özellikle ara: Math.random kullanımı, token/cookie log'u, buffer'a alınan upload, sanitize edilmeden kullanılan dosya adı,
   `nodeIntegration`/`sandbox` ayarları, whitelist dışı IPC, Host header kontrolü, süresi dolmuş ve bilinmeyen token yanıtlarının farkı.
5. Kodu DEĞİŞTİRME. Sadece raporla, eksikleri öncelik sırasıyla listele.
