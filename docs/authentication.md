# Authentication

`zetta` uses your Zetta 3D account: the same library, credits and plan as the website.

## Signing in

### With a browser (default)

```bash
zetta auth login
```

How it works:
1. `zetta` starts a one-time listener on `127.0.0.1`.
2. It opens `zetta3d.ai/plugin-auth`. If you aren't signed in to the website, sign in there first.
3. You click **Connect Zetta CLI**.
4. The page hands a token to the listener. Only zetta3d.ai can do this, and only with a random secret that `zetta` generated for this sign-in.
5. The listener closes.

If a browser can't open automatically, `zetta` prints the address. Open it on the same computer. `--print-url` always prints it instead of opening a browser.

### Without a browser: SSH, containers, remote machines

```bash
zetta auth login --email you@example.com
```

You get an email with a sign-in link. **Copy** the link rather than clicking it, because it works only once, then paste it at the prompt. Without a terminal, run it in two steps:

```bash
zetta auth login --email you@example.com                     # sends the email
zetta auth login --email you@example.com --link "<link>"     # finishes it
```

### With a token: CI, scripts, AI agents

On a machine where you're signed in:

```bash
zetta auth token          # prints the token; store it as a secret
```

Then, wherever zetta runs:

```bash
export ZETTA_TOKEN=…                         # nothing is stored; the variable wins over saved sign-ins
# or save it:
echo "$ZETTA_TOKEN" | zetta auth login --with-token
```

## Checking and signing out

```bash
zetta auth status
```

```
Signed in as you@example.com (creator plan) · profile default · token from keychain · expires in 27 days
```

When fewer than 3 days are left, `auth status` warns you, and commands start failing with `INVALID_SESSION` (exit code 3) once the token expires. Run `zetta auth login` again.

```bash
zetta auth logout         # forgets the saved token for this profile
```

## Where the token is kept

| Order | Source | Notes |
|---|---|---|
| 1 | `ZETTA_TOKEN` environment variable | Never written anywhere |
| 2 | System keychain | macOS Keychain, Windows Credential Manager, or libsecret on Linux desktops |
| 3 | `credentials.json` in the config folder, mode `0600` | Used when there is no keychain (containers, servers), or with `ZETTA_NO_KEYCHAIN=1` |

The config folder is `~/.config/zetta3d` (Windows: `%APPDATA%\zetta3d`), or `ZETTA_CONFIG_DIR`. `zetta doctor` tells you which store is in use.

## Security notes

- **A token is a 30-day key to your account.** Anyone with it can use your credits. Keep it in a secret store, not in scripts or chat logs.
- **Tokens cannot be revoked on the server yet.** `zetta auth logout` deletes the local copy, but a copied token stays valid until it expires. If one leaks, contact support. Revocable API keys are planned.
- **The CLI never sees card details.** `zetta billing checkout` and `zetta billing portal` give you a link to the hosted payment page.

## Profiles: several accounts or servers

Each profile has its own API address and its own sign-in.

```bash
zetta config profiles                                   # default, local, and any you added
zetta --profile local auth login                        # sign in to a local development server
zetta config add-profile staging --api https://staging-api.example.com/api --site https://staging.example.com
zetta config use staging                                # make it the default
ZETTA_PROFILE=staging zetta asset list                  # or pick it per command
```

`local` is built in: it points at `http://localhost:4000/api` and `http://localhost:3000`.
