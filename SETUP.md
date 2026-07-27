# Instagram Tagged Feed — setup

A live feed of posts that tag your Instagram, published free via GitHub Actions +
GitHub Pages, with approve-first moderation inside the Shopify theme editor.

Cost: $0. No app, no server, no hosting bill.

---

## What you need before starting

- An Instagram **Business** or **Creator** account (free to switch:
  Instagram → Settings → Account type and tools). Personal accounts cannot use
  the API at all.
- A GitHub account.

---

## Step 1 — Create the GitHub repo

1. Create a **public** repo named `ig-tagged-feed`.
   Public matters: Actions minutes are unlimited on public repos, and GitHub
   Pages requires a paid plan on private ones. No secrets live in the code —
   the token goes in encrypted repository secrets, never in a file.
2. Push the contents of this folder to it.

## Step 2 — Turn on GitHub Pages

Repo → **Settings → Pages** → Source: **Deploy from a branch**, branch `main`,
folder `/ (root)`. Save.

Your feed will be at:

```
https://YOUR-USERNAME.github.io/ig-tagged-feed/feed.json
```

## Step 3 — Create a Meta app and get a token

This is the fiddly part. Meta reorganises this console regularly, so names may
drift from what's written here — the shape of the flow stays the same.

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Pick the use case that mentions **Instagram**.
3. In the app, add the **Instagram** product and open its **API setup with
   Instagram login** section.
4. Connect your Instagram Business/Creator account.
5. Generate a token with these scopes:
   - `instagram_business_basic`
   - `instagram_business_manage_messages` is *not* needed — skip it
6. Copy the **long-lived access token** and your **Instagram user ID**.

You do **not** need App Review while you're only reading your own account's
tagged media — your own account works in development mode.

## Step 4 — Add the secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name         | Value                         |
| ------------ | ----------------------------- |
| `IG_TOKEN`   | the long-lived access token   |
| `IG_USER_ID` | your Instagram user ID        |

If your token came from the Facebook-login flow instead, also add a
**variable** (not a secret) named `GRAPH_HOST` set to `graph.facebook.com`.

## Step 5 — Import your backlog

Repo → **Actions** → *Update Instagram tagged feed* → **Run workflow**, and
tick **full_sync**. This walks your entire tagged history, not just the recent
window, so you get everything to review in one pass. Do this once.

Watch the log. On success it commits `feed.json` plus mirrored images into
`media/`. Open your Pages URL to confirm you see JSON with posts in it.

From here it re-runs every 6 hours on its own, without full_sync — routine runs
stop as soon as they reach posts already collected, so they stay fast.

Nothing is published by any of this. The Action only *collects*; what appears
on your storefront is decided entirely in Step 6.

> **Token upkeep:** the token lasts 60 days and the script extends it on every
> run, so as long as the Action keeps running you never touch it. If the repo
> goes quiet for over 60 days the token dies and you'd redo Step 3.

## Step 6 — Wire up Shopify

1. Add `sections/instagram-tagged.liquid` to your theme.
2. Customizer → **Add section → Instagram Tagged Feed**.
3. Paste your Pages URL into **Feed URL**.

**Nothing is public yet.** By default the section publishes nothing until you
approve it. A dashed **review tray** appears below the carousel in the editor —
this is your moderation page — listing every tagged post awaiting review.

4. Click each photo you want to feature. It turns green with a ✓.
5. Copy the generated codes into the **Approved posts** field.
6. **Save.**

Only those go live. From then on, new tagged posts collect quietly in the tray
and stay invisible until you approve them the same way.

The tray only renders in the theme editor — customers never see it.

Once a post is approved it stays working forever, even after Instagram stops
returning it: the feed is cumulative and its mirrored image is never pruned.

> Prefer the opposite? Switch **Moderation** to “Show everything, remove what I
> don't want” and the tray inverts — everything goes live and you click photos
> to pull them down into **Removed posts**.

---

## Troubleshooting

**Empty `posts` array but the run succeeded** — nobody has tagged you yet, or
the taggers' accounts are private. Only public tagged posts come back.

**Error code 100 / "nonexisting field"** — the `tags` edge isn't available on
your token type. Add the `GRAPH_HOST` variable from Step 4.

**Error code 190** — the token expired or was revoked. Redo Step 3.

**Images 404 on the storefront** — Pages hasn't finished deploying. Check
Actions for the `pages-build-deployment` run.

---

## A note on reposting

You own your product photos, but customers' photos are theirs. Featuring a
tagged post on your storefront is normal practice and this only ever surfaces
public posts, but a quick "mind if we feature this?" reply is the courteous
move — and it's what keeps you clear if someone later objects.
