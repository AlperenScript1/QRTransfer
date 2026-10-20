# QRTransfer

Desktop-to-phone file transfer over a QR-code session. Built with Electron, TypeScript, and Fastify.

## Transport

- **Local mode:** phone and desktop communicate over the same Wi-Fi network.
- **Remote mode:** attempts WebRTC peer-to-peer transfer, with a temporary Cloudflare HTTPS tunnel as fallback.
- Each session uses a random token, expires automatically, and requires desktop approval for one device.
- Uploads stream directly to disk; file names are sanitized before writing.

## Requirements

- Node.js 20 or newer
- npm

## Development

```bash
npm install
npm run dev
```

## Quality checks

```bash
npm run lint
npm run test
npx tsc --noEmit
```

## Build

```bash
npm run build
npm run package
```

`npm run package` produces a Windows application bundle in `dist/`.

## Security notes

Local-mode HTTP traffic is not encrypted. Use it only on trusted networks. In remote mode, Cloudflare Quick Tunnel provides HTTPS; public STUN servers used by WebRTC may receive network metadata.

## License

MIT
