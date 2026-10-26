# Snappy Chat

A lightweight, self-hosted chat interface that connects to Ollama on another
computer on your local network. The browser talks to this app; the app proxies
requests to Ollama and streams model responses back to the browser.

## Run with Docker Compose

Create a `.env` file beside `docker-compose.yml`. Set your Mac's reserved LAN
address, the PostgreSQL host/container name, port, database and credentials,
and credentials for the initial administrator:

```dotenv
OLLAMA_BASE_URL=http://192.168.1.25:11434
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=snappy_chat
POSTGRES_USER=snappy_chat
POSTGRES_PASSWORD=replace-this-with-your-database-password
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-unique-password
COOKIE_SECURE=false
```

Then start the app:

```sh
docker compose up --build -d
```

Open `http://<unraid-ip>:3000`.

On first startup, Snappy Chat creates its tables and the administrator account
in PostgreSQL. The database user must be allowed to connect to the selected
database and create tables and indexes in its schema. Back up this database to
preserve user accounts and conversation history.

Assistant replies render GitHub-flavored Markdown, including headings, lists,
links, tables, and code blocks. Rendered HTML is sanitized in the browser.
Completed replies show Ollama's prompt/output token counts, prompt evaluation
speed, generation speed, model load time, total time, and time to first token.
The model selector also shows the model's context capacity from Ollama model
metadata; per-reply context usage is an estimate based on prompt and output
token counts, and may differ from the active runtime context setting.

## Unraid container settings

The template is in `unraid/snappy-chat.xml`. Add it to Unraid's container
templates, then set **Ollama Base URL** to the Mac's address, for example
`http://192.168.1.25:11434`, the PostgreSQL container name/host, port, database,
username, and password, and the initial admin username and password. The
template also exposes the web UI port (default `3000`) and a **Secure Session
Cookie** setting. Leave the cookie setting `false` for direct HTTP access on a
trusted LAN; set it to `true` when the app is accessed over HTTPS.

The initial admin settings only bootstrap the account when it does not already
exist. Changing the environment password later does not change the existing
account password; keep the initial password somewhere safe. Password changes
are not yet available in the app. Administrators can create regular user
accounts and view the user list from **Manage users**. There is no public
registration.

The GitHub Actions workflow publishes `ghcr.io/shabarishk/snappy-chat` on pushes
to `main` and on version tags such as `v1.0.0`. The `main` image is tagged
`latest`, matching the Unraid template; version tags are also published under
their corresponding tag. Pull requests build the image without publishing it.

To use the image, make sure GitHub Actions is enabled for the repository. The
first successful publish creates the GHCR package. If you want to install it
from Unraid without logging in, set the package visibility to public in the
package's GitHub settings.

## Prepare Ollama on the Mac

Ollama must listen on a network interface reachable from Unraid, not just
`localhost`. Configure Ollama to bind to `0.0.0.0:11434`, allow the Unraid
server through the Mac firewall, and use a DHCP reservation so the Mac's
address does not change. Verify that the Unraid container can reach
`http://<mac-lan-ip>:11434/api/tags`.

The PostgreSQL container must be reachable from Snappy Chat. On Unraid, put
both containers on a shared custom Docker network and enter the PostgreSQL
container name as **PostgreSQL Container Name / Host**. Alternatively, use the
Unraid host's LAN address and the published database port. Do not expose the
PostgreSQL port, Ollama, or this app directly to the public internet. Use HTTPS
when signing in over an untrusted network.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://192.168.1.100:11434` | Ollama base URL, set to your Mac's LAN address |
| `POSTGRES_HOST` | Required | PostgreSQL container name or network-reachable host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | Required | Existing PostgreSQL database name |
| `POSTGRES_USER` | Required | PostgreSQL username |
| `POSTGRES_PASSWORD` | Required | PostgreSQL password |
| `ADMIN_USERNAME` | Required | Username for the initial administrator account |
| `ADMIN_PASSWORD` | Required | Initial administrator password (12+ characters) |
| `COOKIE_SECURE` | `false` | Set `true` when serving through HTTPS |
| `PORT` | `3000` | Port the web app listens on inside the container |
