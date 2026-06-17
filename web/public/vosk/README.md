# Vosk wake-word model

The small English Vosk model (~50 MB) is **not** committed to git.

From the repo root:

```bash
npm run prepare:vosk
```

This creates `model.tar.gz` here. The service worker caches it after the first load.
