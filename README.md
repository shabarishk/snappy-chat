# Snappy Chat

A lightweight, self-hosted chat interface that connects to Ollama on another
computer on your local network. The browser talks to this app; the app proxies
requests to Ollama and streams model responses back to the browser.

## Run with Docker Compose

Create a `.env` file beside `docker-compose.yml` and set your Mac's reserved
LAN address:

```dotenv
OLLAMA_BASE_URL=http://192.168.1.25:11434
```

Then start the app:

```sh
docker compose up --build -d
```

Open `http://<unraid-ip>:3000`.

## Unraid container settings

The template is in `unraid/snappy-chat.xml`. Add it to Unraid's container
templates, then set **Ollama Base URL** to the Mac's address, for example
`http://192.168.1.25:11434`. The template also exposes the web UI port as a
container setting (default `3000`).

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

Do not expose Ollama or this app directly to the public internet. This initial
version is intended for a trusted LAN and does not include user authentication
or persistent chat history.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://192.168.1.100:11434` | Ollama base URL, set to your Mac's LAN address |
| `PORT` | `3000` | Port the web app listens on inside the container |
