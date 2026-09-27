# client/config — DEMO values, replace before a real exam

- **config.json** — `serverUrl` points at `http://localhost:8443`, a placeholder. Set it to your
  real admin server's address before building for actual use.
- **public-key.pem** — a demo Ed25519 key generated for this repo so `npm run dist:win` /
  `dist:linux` (and the GitHub Actions workflow) build successfully out of the box. It matches
  **no real server** — a browser built with it will refuse every server's policy (signature
  won't verify) until you replace it.

**Before a real exam:** run your admin server once (`cd server && npm start`), then copy
`server/data/keys/public.pem` over this file, set the real `serverUrl` above, and rebuild the
client. See the main README, "Build the installers".
