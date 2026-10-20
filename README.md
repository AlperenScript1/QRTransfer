# QRTransfer

**English** | [Türkçe](#türkçe)

QRTransfer is an open-source desktop app for transferring files between a computer and a phone with a QR code. No mobile app or account is required.

## Features

- Transfer files from phone to desktop
- Send files from desktop to phone
- Use it on the same Wi-Fi network or from a different network
- Prefer direct WebRTC peer-to-peer transfer when available
- Fall back to a temporary HTTPS tunnel when a direct connection is unavailable
- Require desktop approval before a device can transfer files
- Stream incoming files to disk without loading entire files into RAM
- Protect file names against path traversal and Windows reserved names

## How it works

1. Start a session in QRTransfer.
2. Choose **Same network** or **Different network** mode.
3. Scan the QR code with your phone.
4. Approve the device request on the desktop app.
5. Upload files from the phone, or choose files on the desktop for the phone to download.

## Connection modes

### Same network

Your phone and computer must be connected to the same local network. This is usually the fastest option.

### Different network

QRTransfer creates a temporary public HTTPS URL using Cloudflare Quick Tunnel. It attempts a direct WebRTC connection first; if that is unavailable because of NAT or carrier restrictions, the HTTPS tunnel is used as a fallback.

## Security and privacy

- Every session uses a randomly generated 128-bit token.
- Only one approved device can use a session.
- Sessions expire automatically.
- Incoming file names are sanitized and files are never opened automatically.
- Remote mode uses Cloudflare Quick Tunnel. WebRTC uses public STUN servers, which may receive network metadata such as IP addresses.
- Share a QR code or remote link only with people you trust.

> **Important:** Local-network HTTP traffic is not encrypted. Use the same-network mode only on a trusted private network until local TLS support is added.

## Development

```bash
npm install
npm run dev
```

### Checks

```bash
npx tsc --noEmit
npm run lint
npm run test
```

## Build

```bash
npm run build
npm run package
```

## License

MIT

---

## Türkçe

QRTransfer, bilgisayar ile telefon arasında QR kod kullanarak dosya aktarmaya yarayan açık kaynak masaüstü uygulamasıdır. Telefona uygulama kurmak veya hesap açmak gerekmez.

## Özellikler

- Telefondan bilgisayara dosya yükleme
- Bilgisayardan telefona dosya gönderme
- Aynı Wi-Fi ağında veya farklı ağlarda kullanım
- Mümkün olduğunda doğrudan WebRTC eşler arası aktarım
- Doğrudan bağlantı kurulamazsa geçici HTTPS tüneli yedeği
- Aktarımdan önce masaüstünde cihaz onayı
- Dosyaları RAM'e tamamen almadan diske akıtma
- Dosya adlarında path traversal ve Windows ayrılmış ad koruması

## Nasıl çalışır?

1. QRTransfer içinde yeni bir oturum başlatın.
2. **Aynı ağ** veya **Farklı ağ** modunu seçin.
3. Telefonunuzla QR kodu okutun.
4. Masaüstü uygulamasındaki cihaz isteğini onaylayın.
5. Telefondan dosya yükleyin veya bilgisayardan dosya seçip telefona indirin.

## Bağlantı modları

### Aynı ağ

Telefon ve bilgisayar aynı yerel ağa bağlı olmalıdır. Genellikle en hızlı seçenektir.

### Farklı ağ

QRTransfer, Cloudflare Quick Tunnel ile geçici bir herkese açık HTTPS bağlantısı oluşturur. Önce doğrudan WebRTC bağlantısı denenir; NAT ya da operatör kısıtı nedeniyle bu mümkün olmazsa HTTPS tüneli yedek olarak kullanılır.

## Güvenlik ve gizlilik

- Her oturum 128-bit rastgele bir token kullanır.
- Bir oturumu yalnızca tek, onaylanmış cihaz kullanabilir.
- Oturumlar otomatik olarak sona erer.
- Gelen dosya adları güvenli hâle getirilir; dosyalar asla otomatik açılmaz.
- Uzak mod Cloudflare Quick Tunnel kullanır. WebRTC, IP adresi gibi ağ metadatasını görebilecek herkese açık STUN sunucuları kullanır.
- QR kodu veya uzak bağlantıyı yalnızca güvendiğiniz kişilerle paylaşın.

> **Önemli:** Yerel ağdaki HTTP trafiği şifreli değildir. Yerel TLS desteği eklenene kadar aynı ağ modunu yalnızca güvenilir özel ağlarda kullanın.

## Geliştirme

```bash
npm install
npm run dev
```

### Kontroller

```bash
npx tsc --noEmit
npm run lint
npm run test
```

## Derleme

```bash
npm run build
npm run package
```

## Lisans

MIT
