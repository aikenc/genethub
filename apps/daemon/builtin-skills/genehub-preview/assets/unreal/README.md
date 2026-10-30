# Pixel Streaming client (UE 5.4)

`pixelstreaming.esm.js` is Epic's frontend library (MIT, Epic Games, Inc.) built from
`EpicGamesExt/PixelStreamingInfrastructure` branch `UE5.4`, commit
`4857010f8eec0f13657148afc7e70b77f043d4d0` (library 1.1.6), with one change: the `sdp`
dependency is bundled instead of left as an external import
(`externals: {}` in `Frontend/library/webpack.common.js`), because a sandboxed page cannot
resolve bare module names. Build: `npm ci && npm run build` in `Frontend/library`;
use `dist/lib-pixelstreamingfrontend.esm.js`.
SHA-256: `6f3e5cdfe0abe97428b17beb176bb049246c856313b9b8a5ac57ec6a9b990db6`.

Use it with the matching engine only (UE 5.4). For other versions rebuild from that
engine's branch.
