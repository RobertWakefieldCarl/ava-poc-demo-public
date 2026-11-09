# Distributing this skill to a team

The skill is a folder. Distribution is a git repo that colleagues clone into
`~/.cursor/skills/ava-poc-demo`. The only interesting part is the shared ElevenLabs key.

> **This public repo ships no key.** Store your own after cloning:
>
> ```bash
> node scripts/credentials.mjs set elevenlabs
> ```
>
> The rest of this document is for teams who want to share one key from a **private** fork.
> Everything below assumes the repo is private and access-controlled.

---

## 1. The rule about keys in git

**Never commit the key in the clear.** Git history is permanent: a key committed once stays
recoverable in every clone and every fork forever, including after a later commit "removes" it.
Deleting it requires rewriting history and force-pushing, and you still have to assume every
existing clone has it.

So the key is committed **sealed** — encrypted with AES-256-GCM under a passphrase derived by
scrypt. The repo alone is not enough to use it; an attacker needs the repo *and* the passphrase.

This is a real trade-off, stated plainly:

| | Sealed key in the repo | Each person brings their own key |
|---|---|---|
| New joiner effort | One command, one passphrase | Request an ElevenLabs seat, then one command |
| If the repo leaks | Attacker still needs the passphrase | Nothing to leak |
| Revoking one person | Rotate the key for everyone | Disable that person's key |
| Usage attribution | All usage looks like one key | Per person |

A shared key is reasonable for an internal demo tool on a private repo. It is not reasonable for
a public repo, and it gives you no way to cut off one leaver without re-keying everybody.

---

## 2. Maintainer: seal the key once

```bash
node scripts/credentials.mjs set elevenlabs      # your key, from stdin
node scripts/credentials.mjs seal elevenlabs     # writes secrets/elevenlabs.sealed.json
git add secrets/elevenlabs.sealed.json && git commit -m "Seal team ElevenLabs key"
```

Use a generated passphrase of at least 12 characters — `seal` refuses anything shorter, because
that passphrase is the only thing between a repo leak and a working key.

**Send the passphrase out of band.** A password manager share, or a direct message that does not
also contain the repo link. If both travel together, sealing bought you nothing.

---

## 3. New team member: one command

```bash
git clone <repo> ~/.cursor/skills/ava-poc-demo
cd ~/.cursor/skills/ava-poc-demo
node scripts/credentials.mjs bootstrap
```

They are asked for the team passphrase once. The key is decrypted and handed to the operating
system's keystore — DPAPI on Windows, Keychain on macOS, libsecret on Linux. After that the
passphrase is not needed again on that machine, and the key is never written to the skill folder.

For scripted installs, set `AVA_POC_DEMO_PASSPHRASE` instead of answering the prompt.

`node scripts/credentials.mjs status` shows what is installed, as a fingerprint rather than a
usable value, and flags when the sealed key in the repo differs from the one installed locally —
which is how someone notices they are running a key that has since been rotated.

---

## 4. Updating the skill

`git pull`. The keystore lives outside the skill folder, in `%LOCALAPPDATA%` or the OS keychain,
so updating or even deleting and re-cloning the skill never disturbs a stored key.

Only re-run `bootstrap` when the key has been rotated.

---

## 5. Rotating the key

Do this when someone leaves, when the passphrase may have spread, or on a schedule.

1. Issue a new key in ElevenLabs and revoke the old one. **Revoking is the step that matters** —
   until the old key is dead, every existing clone still works.
2. `node scripts/credentials.mjs set elevenlabs` with the new key.
3. `node scripts/credentials.mjs seal elevenlabs` under a **new** passphrase.
4. Commit and push; distribute the new passphrase out of band.
5. Tell the team to re-run `bootstrap`. Until they do, `status` will warn them that the sealed
   key no longer matches their installed one.

The old sealed blob stays in git history, which is fine: it is useless once the key it protects
is revoked. That is the point of revoking rather than deleting.

---

## 6. What must never be committed

`.gitignore` already enforces this, but know why:

- anything in `secrets/` other than `*.sealed.json`
- the passphrase, in any file, including this one
- `.env` files, `*.key`, `*.pem`
- `poc-demo/` output — it contains customer branding and sometimes a real phone number, and
  belongs in that customer's `axl-sessions/` folder

Before the first push, check the history is clean:

```bash
git log -p | grep -iE "sk_[0-9a-f]{20,}" && echo "STOP: a key is in history"
```
