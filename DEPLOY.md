# Deploying to a Hostinger VPS (one live store)

This puts the app on your VPS with Docker. Caddy handles HTTPS automatically. The database and job files are kept in
`/opt/bulkport/data` on the server, so they survive updates. Allow about an hour the first time.

You need:

* The Hostinger VPS (Ubuntu 22.04 or 24.04) and its IP address.
* A domain or subdomain you control, e.g. `bulkport.yourdomain.co.uk`.
* A Shopify Partner account (free: https://partners.shopify.com) and your store's `xxxx.myshopify.com` address.
* On your own computer: Node 22+, Git and the Shopify CLI (`npm install -g @shopify/cli`).

Below, replace `bulkport.yourdomain.co.uk` with your domain.

## 1. Point the domain at the VPS

Wherever your domain's DNS is managed (Hostinger hPanel → Domains → DNS, if it's with Hostinger), add an **A record**:

| Type | Name | Points to |
| --- | --- | --- |
| A | `bulkport` | your VPS IP address |

It can take a few minutes to an hour to work. Check with `ping bulkport.yourdomain.co.uk`.

## 2. Create the app in Shopify (on your own computer)

```shell
git clone https://github.com/tulipyshopify/matrixifycopy.git bulkport
cd bulkport
npm install
shopify app config link
```

`config link` asks you to log in to your Partner account. Choose **"Create a new app"**. It writes the app's
`client_id` into `shopify.app.toml`.

Open `shopify.app.toml` and set the production address (add these lines if they aren't there):

```toml
application_url = "https://bulkport.yourdomain.co.uk"
embedded = true

[auth]
redirect_urls = [
  "https://bulkport.yourdomain.co.uk/auth/callback",
  "https://bulkport.yourdomain.co.uk/auth/shopify/callback",
  "https://bulkport.yourdomain.co.uk/api/auth/callback",
]

[build]
automatically_update_urls_on_dev = false
```

Then publish the configuration (URLs, access scopes, webhooks) to Shopify, and push the file so the server gets it:

```shell
shopify app deploy
git commit -am "Production app config" && git push
```

`client_id` is not a secret, so committing it is fine. **Never commit the API secret.**

## 3. Partner Dashboard settings

In https://partners.shopify.com → Apps → your app:

1. **API access → Protected customer data access**: request access to customer data and to the Name, Email, Phone and
   Address fields. Without this, the Customers, Orders, Draft Orders and Companies sheets fail.
2. **API access → Read all orders**: request it if you need to export orders older than 60 days.
3. **Client credentials**: note the **Client ID** and **Client secret** for step 4.
4. **Distribution → Custom distribution**: enter your store's `xxxx.myshopify.com` address. This gives you the
   install link used in step 5. (Shopify doesn't let you change distribution afterwards. Custom is right for one
   store.)

## 4. Start it on the VPS

SSH into the VPS (Hostinger hPanel → VPS → SSH access shows the command), then:

```shell
# Docker (skip if you chose Hostinger's "Ubuntu with Docker" template)
curl -fsSL https://get.docker.com | sh

# Open the web ports if the firewall is on (also check hPanel → VPS → Firewall)
ufw allow 22,80,443/tcp

# Let the server read your private GitHub repo with a deploy key
ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub
```

Add that public key in GitHub → `tulipyshopify/matrixifycopy` → Settings → Deploy keys → Add (read-only is enough).
Then:

```shell
GIT_SSH_COMMAND="ssh -i ~/.ssh/github_deploy" git clone git@github.com:tulipyshopify/matrixifycopy.git /opt/bulkport
cd /opt/bulkport
git config core.sshCommand "ssh -i ~/.ssh/github_deploy"

cp .env.production.example .env.production
nano .env.production        # fill in SHOPIFY_API_KEY (Client ID), SHOPIFY_API_SECRET, SHOPIFY_APP_URL
echo "APP_DOMAIN=bulkport.yourdomain.co.uk" > .env

docker compose up -d --build
docker compose logs -f app  # wait for "[worker] started"; Ctrl+C to stop watching
```

Check https://bulkport.yourdomain.co.uk opens with a padlock (it shows a log-in page; that's expected).

## 5. Install on your store

Open the custom distribution install link from step 3, choose your store and approve the permissions. The app appears
under **Apps** in your Shopify admin.

## 6. First steps on the live store

This app has been tested against a simulated Shopify API, not yet against a real store. Go step by step:

1. **Export first.** Run a full export of everything you care about. Download it and keep it as your backup.
2. **Small, safe import.** Take a few rows from that export, change one harmless field (e.g. a tag on a test product),
   tick **Dry run**, import, and read the result file. Then run it again without Dry run and check the product in
   Shopify admin.
3. **Use MERGE** (the default) while you build confidence. Avoid **REPLACE** and **DELETE** until you've watched them work
   on a test product.
4. Multi-location stock: use the `Inventory Available: <Location>` columns. `Variant Inventory Qty` is ignored when
   there's more than one location.

## Updating

```shell
cd /opt/bulkport && git pull && docker compose up -d --build
```

Jobs that are running during an update: exports restart automatically, imports are marked failed (check the store
before re-running).

## Backups

Everything the app stores is in `/opt/bulkport/data`: the database (job history, schedules, Shopify sessions) and job
files. A nightly copy:

```shell
crontab -e
# add:
0 3 * * * tar czf /root/bulkport-backup-$(date +\%a).tgz -C /opt/bulkport data
```

## Troubleshooting

* **No padlock / certificate errors**: the A record isn't pointing at the VPS yet, or ports 80/443 are blocked. See
  `docker compose logs caddy`.
* **"Oauth error" or a redirect loop when opening the app**: `SHOPIFY_APP_URL` in `.env.production` and
  `application_url` in `shopify.app.toml` must both be exactly `https://bulkport.yourdomain.co.uk`. After changing the
  toml, run `shopify app deploy` again.
* **Customers/Orders exports fail with an access error**: protected customer data access (step 3) isn't approved yet.
* **A job is stuck**: `docker compose logs app`, and the job's Log on its page in the app.
